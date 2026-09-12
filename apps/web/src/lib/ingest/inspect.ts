import { createHash } from 'node:crypto';
import { type ParseSettings, parseSettingsHashInput } from '@konusbitr/shared';
import { IngestError } from './errors';
import { PdfInspectionError, PdfScanner } from './pdf';

/**
 * The one pass every byte takes on the way in.
 *
 * Whether the bytes arrived by presigned upload or by URL import, exactly one
 * traversal answers everything the intake path needs: what they hash to, how
 * many there are, whether they are really a PDF, and whether they are safe to
 * hand to a parser. Doing it once, streaming, is what lets a 200MB document be
 * accepted by a web process that never holds more than a chunk of it.
 */

export type InspectOptions = {
  /** Hard ceiling. Exceeding it aborts the read rather than failing afterwards. */
  maxBytes: number;
  /** Page ceiling, or `0` for unlimited — the self-hosted default. */
  maxPages: number;
  /**
   * Called with every chunk before it is inspected.
   *
   * URL import uses this to write the bytes onward to object storage while they
   * are being read, so the file is stored and validated in one pass instead of
   * being buffered between the two.
   */
  onChunk?: (chunk: Uint8Array) => void | Promise<void>;
};

export type Inspection = {
  /** `sha256` of the bytes — half of the docId cache key. */
  contentHash: string;
  byteSize: number;
  /** `null` when the file hides its page objects inside an object stream. */
  pageCount: number | null;
};

export async function inspectDocumentStream(
  source: AsyncIterable<Uint8Array>,
  options: InspectOptions,
): Promise<Inspection> {
  const hash = createHash('sha256');
  const scanner = new PdfScanner();
  let byteSize = 0;

  try {
    for await (const chunk of source) {
      byteSize += chunk.byteLength;
      if (byteSize > options.maxBytes) {
        throw IngestError.tooLarge(
          `That file is larger than the ${formatBytes(options.maxBytes)} upload limit.`,
        );
      }

      if (options.onChunk) await options.onChunk(chunk);
      hash.update(chunk);
      scanner.feed(chunk);
    }

    const inspection = scanner.end();

    if (byteSize === 0) {
      throw IngestError.badRequest('empty_file', 'That file is empty.');
    }

    if (
      options.maxPages > 0 &&
      inspection.pageCount !== null &&
      inspection.pageCount > options.maxPages
    ) {
      throw IngestError.tooLarge(
        `That document has ${inspection.pageCount} pages; this Konusbitr accepts up to ${options.maxPages}.`,
      );
    }

    return {
      contentHash: hash.digest('hex'),
      byteSize,
      pageCount: inspection.pageCount,
    };
  } catch (error) {
    if (error instanceof PdfInspectionError) {
      // The scanner speaks about PDFs; the route speaks HTTP. This is the one
      // place the two meet, so every structural refusal gets its status here
      // rather than being re-derived at each call site.
      throw error.reason === 'not-a-pdf'
        ? IngestError.unsupportedMedia('unsupported_media_type', error.message)
        : IngestError.unprocessable(
            error.reason === 'encrypted' ? 'encrypted_pdf' : 'decompression_bomb',
            error.message,
          );
    }
    throw error;
  }
}

/**
 * The settings half of the docId cache key.
 *
 * `sha256` of the canonical JSON from `@konusbitr/shared` — the hashing lives
 * here because that package stays free of Node built-ins, and the string being
 * hashed lives there because it is the cross-runtime contract.
 */
export function settingsHash(settings: ParseSettings): string {
  return createHash('sha256').update(parseSettingsHashInput(settings), 'utf8').digest('hex');
}

/** For limit messages, where "524288000 bytes" helps nobody. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded =
    value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${units[unit]}`;
}
