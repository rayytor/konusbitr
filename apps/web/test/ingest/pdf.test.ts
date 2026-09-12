import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PdfInspectionError, PdfScanner, sniffPdf } from '@/lib/ingest/pdf';

/**
 * The structural scanner, against files built to trip each of its checks.
 *
 * Two of these are acceptance criteria of Phase 05 — an encrypted PDF and a PDF
 * bomb must both be refused with an actionable message — so the fixtures are
 * built here rather than committed as binaries: a reader can see exactly what
 * makes each one what it is.
 */

/** Assemble a PDF-ish file from literal pieces. */
function pdf(...parts: (string | Buffer)[]): Buffer {
  return Buffer.concat(
    parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : part)),
  );
}

/** A stream object whose payload is deflate-compressed, as a real PDF's is. */
function flateStream(objectNumber: number, payload: Buffer): Buffer {
  const compressed = deflateSync(payload);
  return pdf(
    `${objectNumber} 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
    compressed,
    '\nendstream\nendobj\n',
  );
}

const ORDINARY = pdf(
  '%PDF-1.7\n',
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n',
  '3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n',
  '4 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n',
  flateStream(5, Buffer.from('BT /F1 12 Tf (hello) Tj ET', 'latin1')),
  'trailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF\n',
);

/** Feed a whole file to a scanner in chunks of the given size. */
function scan(file: Buffer, chunkSize = file.length) {
  const scanner = new PdfScanner();
  for (let at = 0; at < file.length; at += chunkSize) {
    scanner.feed(file.subarray(at, at + chunkSize));
  }
  return scanner.end();
}

describe('sniffPdf', () => {
  it('recognises a PDF by its header, not by its extension', () => {
    expect(sniffPdf(Buffer.from('%PDF-1.4\n...', 'latin1'))).toBe(true);
    expect(sniffPdf(Buffer.from('PK', 'latin1'))).toBe(false);
  });
});

describe('an ordinary PDF', () => {
  it('is accepted, and its pages are counted', () => {
    expect(scan(ORDINARY).pageCount).toBe(2);
  });

  it('reads the same however the bytes are chunked', () => {
    // The scanner keeps an overlap between chunks so a keyword split across a
    // boundary still matches — and, just as importantly, is not counted twice.
    for (const chunkSize of [1, 3, 7, 13, 64, 65, 4096]) {
      expect(scan(ORDINARY, chunkSize).pageCount, `chunk size ${chunkSize}`).toBe(2);
    }
  });

  it('falls back to the page tree’s own /Count when pages are hidden in a stream', () => {
    const compressedPages = pdf(
      '%PDF-1.7\n',
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 17 >>\nendobj\n',
      flateStream(3, Buffer.from('<< /Type /Page >> << /Type /Page >>', 'latin1')),
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
    );

    expect(scan(compressedPages).pageCount).toBe(17);
  });

  it('reports an unknown page count rather than guessing', () => {
    const opaque = pdf('%PDF-1.7\n', 'trailer\n<< /Size 1 >>\n%%EOF\n');
    expect(scan(opaque).pageCount).toBeNull();
  });
});

describe('a file that is not a PDF', () => {
  it.each([
    ['a ZIP', Buffer.from('PK the rest of a zip', 'latin1')],
    ['plain text', Buffer.from('Dear Ada,\n\nRegards,\n', 'latin1')],
    ['empty', Buffer.alloc(0)],
  ])('is refused: %s', (_label, bytes) => {
    expect(() => scan(bytes)).toThrow(expect.objectContaining({ reason: 'not-a-pdf' }));
  });

  it('says what to do about it', () => {
    try {
      scan(Buffer.from('PK', 'latin1'));
      expect.unreachable('a ZIP must not pass as a PDF');
    } catch (error) {
      expect(error).toBeInstanceOf(PdfInspectionError);
      expect((error as Error).message).toMatch(/not a PDF/i);
    }
  });
});

describe('an encrypted PDF', () => {
  const encrypted = pdf(
    '%PDF-1.7\n',
    '1 0 obj\n<< /Type /Catalog >>\nendobj\n',
    '5 0 obj\n<< /Filter /Standard /V 2 /R 3 /Length 128 >>\nendobj\n',
    'trailer\n<< /Root 1 0 R /Encrypt 5 0 R /ID [<ab> <cd>] >>\n%%EOF\n',
  );

  it('is refused with a message that says what to do', () => {
    try {
      scan(encrypted);
      expect.unreachable('an encrypted PDF must be refused');
    } catch (error) {
      expect((error as PdfInspectionError).reason).toBe('encrypted');
      expect((error as Error).message).toMatch(/password protection/i);
    }
  });

  it('is refused however the bytes are chunked', () => {
    for (const chunkSize of [1, 5, 64, 4096]) {
      expect(() => scan(encrypted, chunkSize)).toThrow(
        expect.objectContaining({ reason: 'encrypted' }),
      );
    }
  });

  it('does not fire on the same bytes appearing inside a compressed stream', () => {
    // The point of tracking `stream … endstream`: `/Encrypt` in a content
    // stream is a coincidence, not an encryption dictionary.
    const innocent = pdf(
      '%PDF-1.7\n',
      '1 0 obj\n<< /Type /Page >>\nendobj\n',
      flateStream(2, Buffer.from('BT (/Encrypt is just a word here) Tj ET', 'latin1')),
      'trailer\n<< /Size 3 >>\n%%EOF\n',
    );

    expect(() => scan(innocent)).not.toThrow();
  });
});

describe('a decompression bomb', () => {
  /**
   * 80MiB of zeros in a stream that compresses to a few dozen KB.
   *
   * This is the whole trick: the file is small enough to upload in a second and
   * large enough to exhaust a parser that decompresses it without a ceiling.
   */
  const bomb = pdf(
    '%PDF-1.7\n',
    '1 0 obj\n<< /Type /Page >>\nendobj\n',
    flateStream(2, Buffer.alloc(80 * 1024 * 1024)),
    'trailer\n<< /Size 3 >>\n%%EOF\n',
  );

  it('is far smaller than what it expands to', () => {
    expect(bomb.length).toBeLessThan(1024 * 1024);
  });

  it('is refused with a message that says what happened', () => {
    try {
      scan(bomb);
      expect.unreachable('a decompression bomb must be refused');
    } catch (error) {
      expect((error as PdfInspectionError).reason).toBe('bomb');
      expect((error as Error).message).toMatch(/decompression bomb/i);
      expect((error as Error).message).toMatch(/not been stored/i);
    }
  });

  it('is refused when it arrives in chunks, as it would over a network', () => {
    expect(() => scan(bomb, 64 * 1024)).toThrow(expect.objectContaining({ reason: 'bomb' }));
  });

  it('leaves an ordinary compressed document alone', () => {
    // A megabyte of real-looking text compresses well, but nowhere near enough
    // to read as an attack — the ceiling must not be a false-positive machine.
    const wordy = Buffer.from('The quick brown fox. '.repeat(50_000), 'latin1');
    const ordinary = pdf(
      '%PDF-1.7\n',
      '1 0 obj\n<< /Type /Page >>\nendobj\n',
      flateStream(2, wordy),
      'trailer\n<< /Size 3 >>\n%%EOF\n',
    );

    expect(() => scan(ordinary)).not.toThrow();
  });
});
