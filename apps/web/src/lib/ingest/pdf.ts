import { inflateSync, constants as zlibConstants } from 'node:zlib';

/**
 * What a PDF is, structurally, without parsing one.
 *
 * Three questions have to be answered about bytes that arrived from outside
 * before anything expensive happens to them: are these really a PDF, is it
 * encrypted, and will decompressing it exhaust the machine. A full parser could
 * answer all three, but a full parser is also the thing we are trying not to
 * hand hostile input to, and it lives in the Python worker behind a queue.
 *
 * So this is a byte scanner. It walks the file once, in chunks, tracking only
 * whether it is currently inside a `stream … endstream` region. That single bit
 * of structure is worth a surprising amount:
 *
 * - `/Encrypt` **outside** a stream is the encryption dictionary; the same
 *   bytes inside a compressed content stream are a coincidence, and knowing the
 *   difference removes the heuristic's main false positive.
 * - Every `stream` region is a decompression candidate, so the expansion ratio
 *   can be measured without knowing anything about the document's object graph.
 * - `/Type /Page` outside a stream counts pages, when the file does not hide
 *   its page objects inside an object stream.
 *
 * It is a heuristic and it is written down as one. Phase 12 is where robust
 * ingestion deepens it; what it must do *now* is refuse the two files named in
 * this phase's acceptance criteria, and do it without loading 500MB into heap.
 */

/** `%PDF-` — the header every PDF starts with, within the first bytes. */
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/**
 * How far into the file the header may sit.
 *
 * Zero, by the specification. In practice readers tolerate junk in front of it
 * and so do we, up to a line or so — but not so far that an arbitrary file with
 * `%PDF-` buried in it passes as a document.
 */
const MAGIC_SEARCH_BYTES = 1024;

/**
 * Bytes retained between chunks so a token split across them still matches.
 *
 * Wide enough for the longest thing the scanner looks for — the page tree's
 * `/Type /Pages … /Count n`, which the specification lets a producer pad with
 * other entries — not just for the short keywords.
 */
const OVERLAP_BYTES = 256;

/** Bytes of trailing context the outside scanners may look at but not finalize. */
const LOOKAHEAD_BYTES = 8;

/**
 * Compressed bytes sampled from each stream region for expansion analysis.
 *
 * A decompression bomb is by construction a *small* compressed region with an
 * enormous expansion, so the front of each region is where it shows itself. The
 * cap is what keeps this analysis O(1) in memory on a 500MB upload.
 */
const BOMB_SAMPLE_BYTES = 4 * 1024 * 1024;

/**
 * Ceiling on what one stream may inflate to.
 *
 * A page's content stream, an embedded font, even a large scanned image are far
 * below this. Nothing legitimate in a PDF inflates to 64MiB from a 4MiB sample,
 * so hitting the cap is the bomb signal — and because `inflateSync` enforces it
 * itself, the oversized output is never allocated.
 */
const MAX_STREAM_INFLATED_BYTES = 64 * 1024 * 1024;

/**
 * How much larger than the file its decompressed streams may total.
 *
 * A single stream can be within its own ceiling while a thousand of them
 * together are not, which is the other shape a bomb comes in. The absolute
 * floor beside it stops a 4KB file with a 2MB stream — an ordinary ratio for a
 * tiny document — from reading as an attack.
 */
const MAX_EXPANSION_RATIO = 100;
const EXPANSION_FLOOR_BYTES = 64 * 1024 * 1024;

export type PdfRejection = 'not-a-pdf' | 'encrypted' | 'bomb';

export class PdfInspectionError extends Error {
  override readonly name = 'PdfInspectionError';
  constructor(
    message: string,
    readonly reason: PdfRejection,
  ) {
    super(message);
  }
}

export type PdfInspection = {
  /** Pages found, or `null` when the file keeps them inside an object stream. */
  pageCount: number | null;
  /** Total bytes the sampled streams inflated to — the health metric behind the cap. */
  inflatedBytes: number;
};

/**
 * A single pass over a PDF's bytes.
 *
 * Fed chunk by chunk; throws {@link PdfInspectionError} the moment it is sure,
 * so a bomb is refused part-way through rather than after the whole thing has
 * been read.
 */
export class PdfScanner {
  /** Unprocessed bytes, plus the overlap already processed last round. */
  private pending: Buffer = Buffer.alloc(0);
  /** How many bytes at the front of `pending` were already handled. */
  private overlap = 0;

  private seenBytes = 0;
  private header: Buffer = Buffer.alloc(0);
  private headerChecked = false;

  private insideStream = false;
  private sample: Buffer[] = [];
  private sampleBytes = 0;

  private encryptHits = 0;
  private pageHits = 0;
  private declaredPageCount: number | null = null;
  private inflatedBytes = 0;

  feed(chunk: Uint8Array): void {
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.seenBytes += buffer.byteLength;

    if (!this.headerChecked) {
      this.header = Buffer.concat([this.header, buffer]).subarray(0, MAGIC_SEARCH_BYTES);
      // Only decide once the whole search window has arrived: the header is
      // allowed a little junk in front of it, so five bytes is not yet a verdict.
      if (this.header.byteLength >= MAGIC_SEARCH_BYTES) this.checkHeader();
    }

    this.pending = Buffer.concat([this.pending, buffer]);
    this.scan(false);
  }

  /** Finish the last region and report. Throws if the file was never a PDF. */
  end(): PdfInspection {
    this.checkHeader();
    // The final pass is the only one allowed to treat the end of the buffer as
    // the end of the file; every earlier one holds the tail back in case a
    // token continues into the next chunk.
    this.scan(true);
    if (this.insideStream) this.finishStreamRegion();

    if (this.encryptHits > 0) {
      throw new PdfInspectionError(
        'This PDF is encrypted. Remove its password protection and upload it again.',
        'encrypted',
      );
    }

    this.checkExpansion();

    return {
      pageCount: this.pageCount(),
      inflatedBytes: this.inflatedBytes,
    };
  }

  private pageCount(): number | null {
    if (this.pageHits > 0) return this.pageHits;
    // Nothing outside a stream said "page", which means the page objects are in
    // an object stream. The `/Count` on the page tree is the next best answer,
    // and when that is compressed too the honest answer is "not known yet" —
    // the worker will report it after parsing.
    return this.declaredPageCount;
  }

  private checkHeader(): void {
    if (this.headerChecked) return;
    this.headerChecked = true;
    if (this.header.indexOf(PDF_MAGIC) === -1) {
      throw new PdfInspectionError(
        'That file is not a PDF. Konusbitr reads PDFs today; other formats are coming.',
        'not-a-pdf',
      );
    }
  }

  /**
   * Walk `pending`, routing bytes to the stream sampler or the outside scanners.
   *
   * Two watermarks keep a chunked read identical to a whole-file one:
   *
   * - `overlap` — leading bytes already finalized in an earlier round. A match
   *   that ends at or before it has been counted, and counting it again would
   *   double every page in a file read a byte at a time.
   * - `limit` — how far this round may finalize. Until the file ends, the last
   *   {@link OVERLAP_BYTES} are held back, because a token that runs off the end
   *   of the buffer is not yet a token; it might continue in the next chunk.
   */
  private scan(final: boolean): void {
    const buffer = this.pending;
    const limit = final
      ? buffer.byteLength
      : Math.max(this.overlap, buffer.byteLength - OVERLAP_BYTES);

    let position = 0;

    while (position < limit) {
      if (this.insideStream) {
        const end = indexOfNew(buffer, ENDSTREAM, position, this.overlap, limit);
        if (end === -1) {
          this.sampleFrom(buffer, position, limit);
          break;
        }
        this.sampleFrom(buffer, position, end);
        this.finishStreamRegion();
        this.insideStream = false;
        position = end + ENDSTREAM.byteLength;
      } else {
        const start = this.findStreamKeyword(buffer, position, limit);
        if (start === -1) {
          this.scanOutside(buffer, position, limit);
          break;
        }
        this.scanOutside(buffer, position, start);
        this.insideStream = true;
        this.sample = [];
        this.sampleBytes = 0;
        // The specification puts an end-of-line between the keyword and the
        // data. Sampling from before it would hand zlib a stray byte and every
        // inflate would fail, which is a bomb detector that detects nothing.
        position = start + STREAM.byteLength + eolLength(buffer, start + STREAM.byteLength);
      }
    }

    // Keep the finalized lookback plus everything past the limit.
    const keep = Math.min(OVERLAP_BYTES, limit);
    this.pending = Buffer.from(buffer.subarray(limit - keep));
    this.overlap = keep;
  }

  /**
   * The next `stream` keyword that opens a region.
   *
   * `endstream` contains `stream`, and the specification requires the keyword
   * to be followed by an end-of-line, so both are checked — a dictionary entry
   * ending in `stream` would otherwise open a phantom region and swallow the
   * rest of the file.
   */
  private findStreamKeyword(buffer: Buffer, from: number, limit: number): number {
    let at = from;
    while (at < limit) {
      const index = buffer.indexOf(STREAM, at);
      if (index === -1 || index + STREAM.byteLength > limit) return -1;
      at = index + 1;

      if (index + STREAM.byteLength <= this.overlap) continue;
      if (index >= 3 && buffer.subarray(index - 3, index).equals(END)) continue;

      const next = buffer[index + STREAM.byteLength];
      if (next === 0x0a || next === 0x0d) return index;
    }
    return -1;
  }

  /** Collect compressed bytes for expansion analysis, up to the sample cap. */
  private sampleFrom(buffer: Buffer, start: number, end: number): void {
    const from = Math.max(start, this.overlap);
    if (from >= end || this.sampleBytes >= BOMB_SAMPLE_BYTES) return;

    const slice = buffer.subarray(
      from,
      Math.min(end, from + (BOMB_SAMPLE_BYTES - this.sampleBytes)),
    );
    this.sample.push(Buffer.from(slice));
    this.sampleBytes += slice.byteLength;
  }

  /**
   * Count the tokens that are only meaningful outside a compressed stream.
   *
   * The regex is given a few bytes past `end` as context but is not allowed to
   * finalize a match there. Without that, a `/Type /Page` sitting at a chunk
   * boundary would satisfy the "not `/Pages`" lookahead simply because the `s`
   * had not arrived yet.
   */
  private scanOutside(buffer: Buffer, start: number, end: number): void {
    if (end <= start) return;

    const context = Math.min(end + LOOKAHEAD_BYTES, buffer.byteLength);
    const text = buffer.subarray(start, context).toString('latin1');

    const isNew = (match: RegExpExecArray | RegExpMatchArray): boolean => {
      const endsAt = start + (match.index ?? 0) + match[0].length;
      return endsAt > this.overlap && endsAt <= end;
    };

    for (const match of text.matchAll(ENCRYPT_PATTERN)) if (isNew(match)) this.encryptHits += 1;
    for (const match of text.matchAll(PAGE_PATTERN)) if (isNew(match)) this.pageHits += 1;

    // `/Type /Pages … /Count 42` is the page tree's own tally. Only consulted
    // when no page objects were visible, so a wrong guess here cannot override
    // a real count.
    for (const match of text.matchAll(PAGES_COUNT_PATTERN)) {
      if (!isNew(match)) continue;
      const value = Number(match[1]);
      if (Number.isInteger(value) && value > 0) {
        this.declaredPageCount = Math.max(this.declaredPageCount ?? 0, value);
      }
    }
  }

  /**
   * Inflate this region's sample and hold it to the ceiling.
   *
   * `Z_SYNC_FLUSH` is what makes inflating a *prefix* of a deflate stream
   * legal — without it, a truncated sample is an error rather than a partial
   * answer. Regions that are not deflate at all (raw images, already-compressed
   * JPEG data) simply fail to inflate, and that is not a problem: they cannot
   * be decompression bombs either.
   */
  private finishStreamRegion(): void {
    const sample = this.sample.length === 1 ? this.sample[0] : Buffer.concat(this.sample);
    this.sample = [];
    this.sampleBytes = 0;

    if (!sample || sample.byteLength < 32) return;

    let inflated: Buffer;
    try {
      inflated = inflateSync(sample, {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
        maxOutputLength: MAX_STREAM_INFLATED_BYTES,
      });
    } catch (error) {
      if (isOutputTooLarge(error)) {
        throw new PdfInspectionError(
          'This PDF expands to far more data than its size suggests, which is how a decompression bomb is built. It has not been stored.',
          'bomb',
        );
      }
      // Not deflate-compressed, or a sample cut somewhere zlib cannot resume
      // from. Either way there is nothing to measure.
      return;
    }

    this.inflatedBytes += inflated.byteLength;
    this.checkExpansion();
  }

  private checkExpansion(): void {
    if (this.inflatedBytes <= EXPANSION_FLOOR_BYTES) return;
    if (this.inflatedBytes <= this.seenBytes * MAX_EXPANSION_RATIO) return;

    throw new PdfInspectionError(
      'This PDF expands to far more data than its size suggests, which is how a decompression bomb is built. It has not been stored.',
      'bomb',
    );
  }
}

const STREAM = Buffer.from('stream', 'latin1');
const ENDSTREAM = Buffer.from('endstream', 'latin1');
const END = Buffer.from('end', 'latin1');

const ENCRYPT_PATTERN = /\/Encrypt\b/g;
/** `/Type /Page` but never `/Type /Pages`, with the whitespace PDFs really use. */
const PAGE_PATTERN = /\/Type\s*\/Page(?![a-zA-Z])/g;
const PAGES_COUNT_PATTERN = /\/Type\s*\/Pages\b[^>]{0,120}?\/Count\s+(\d+)/g;

/** Length of the end-of-line at `at`: 2 for CRLF, 1 for a bare CR or LF, else 0. */
function eolLength(buffer: Buffer, at: number): number {
  if (buffer[at] === 0x0d) return buffer[at + 1] === 0x0a ? 2 : 1;
  if (buffer[at] === 0x0a) return 1;
  return 0;
}

/** The first complete occurrence of `token` that is new and lands within `limit`. */
function indexOfNew(
  buffer: Buffer,
  token: Buffer,
  from: number,
  boundary: number,
  limit: number,
): number {
  let at = from;
  while (at < limit) {
    const index = buffer.indexOf(token, at);
    if (index === -1 || index + token.byteLength > limit) return -1;
    if (index + token.byteLength > boundary) return index;
    at = index + 1;
  }
  return -1;
}

function isOutputTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
  );
}

/** Whether these opening bytes look like a PDF at all. */
export function sniffPdf(head: Uint8Array): boolean {
  return Buffer.from(head).subarray(0, MAGIC_SEARCH_BYTES).indexOf(PDF_MAGIC) !== -1;
}
