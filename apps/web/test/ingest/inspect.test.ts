import { createHash } from 'node:crypto';
import { DEFAULT_PARSE_SETTINGS } from '@konusbitr/shared';
import { describe, expect, it } from 'vitest';
import { IngestError } from '@/lib/ingest/errors';
import { formatBytes, inspectDocumentStream, settingsHash } from '@/lib/ingest/inspect';

/**
 * The one pass every byte takes on the way in.
 *
 * What matters here is that the four things it produces — a hash, a size, a
 * verdict and a page count — all come from the same single traversal, and that
 * a refusal is an {@link IngestError} carrying a status the route can return
 * rather than an exception the caller has to interpret.
 */

const PDF = Buffer.from(
  '%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\ntrailer\n<< /Size 2 >>\n%%EOF\n',
  'latin1',
);

/** Deliver a buffer as an async stream, optionally in small pieces. */
async function* streamOf(bytes: Buffer, chunkSize = bytes.length): AsyncIterable<Uint8Array> {
  for (let at = 0; at < bytes.length; at += chunkSize) {
    yield bytes.subarray(at, at + chunkSize);
  }
}

const LIMITS = { maxBytes: 10 * 1024 * 1024, maxPages: 0 };

describe('inspectDocumentStream', () => {
  it('hashes, sizes and counts in one traversal', async () => {
    const inspection = await inspectDocumentStream(streamOf(PDF), LIMITS);

    expect(inspection.contentHash).toBe(createHash('sha256').update(PDF).digest('hex'));
    expect(inspection.byteSize).toBe(PDF.length);
    expect(inspection.pageCount).toBe(1);
  });

  it('reaches the same answer whatever the chunk size', async () => {
    const whole = await inspectDocumentStream(streamOf(PDF), LIMITS);
    const pieces = await inspectDocumentStream(streamOf(PDF, 5), LIMITS);

    expect(pieces).toEqual(whole);
  });

  it('tees every chunk onward before inspecting it', async () => {
    // This is what lets URL import store and validate in one pass rather than
    // buffering the download in front of the upload.
    const seen: Buffer[] = [];
    await inspectDocumentStream(streamOf(PDF, 7), {
      ...LIMITS,
      onChunk: (chunk) => {
        seen.push(Buffer.from(chunk));
      },
    });

    expect(Buffer.concat(seen)).toEqual(PDF);
  });

  it('stops reading the moment the size cap is passed', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(4096)]);
    let delivered = 0;

    await expect(
      inspectDocumentStream(streamOf(big, 256), {
        ...LIMITS,
        maxBytes: 512,
        onChunk: () => {
          delivered += 1;
        },
      }),
    ).rejects.toThrow(expect.objectContaining({ status: 413 }));

    // Two chunks fit under the cap; the third crossed it and was never teed.
    expect(delivered).toBe(2);
  });

  it('refuses an empty object', async () => {
    await expect(inspectDocumentStream(streamOf(Buffer.alloc(0)), LIMITS)).rejects.toThrow(
      IngestError,
    );
  });

  it('turns "not a PDF" into a 415 the route can return', async () => {
    await expect(
      inspectDocumentStream(streamOf(Buffer.from('PK not a pdf')), LIMITS),
    ).rejects.toThrow(expect.objectContaining({ status: 415, code: 'unsupported_media_type' }));
  });

  it('turns an encrypted PDF into a 422 naming the reason', async () => {
    const encrypted = Buffer.from(
      '%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\ntrailer\n<< /Encrypt 5 0 R >>\n%%EOF\n',
      'latin1',
    );

    await expect(inspectDocumentStream(streamOf(encrypted), LIMITS)).rejects.toThrow(
      expect.objectContaining({ status: 422, code: 'encrypted_pdf' }),
    );
  });

  it('enforces MAX_PAGES when it is set, and ignores it when it is zero', async () => {
    const twoPages = Buffer.from(
      '%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n',
      'latin1',
    );

    await expect(
      inspectDocumentStream(streamOf(twoPages), { ...LIMITS, maxPages: 1 }),
    ).rejects.toThrow(expect.objectContaining({ status: 413 }));

    await expect(
      inspectDocumentStream(streamOf(twoPages), { ...LIMITS, maxPages: 0 }),
    ).resolves.toMatchObject({ pageCount: 2 });
  });
});

describe('settingsHash', () => {
  it('is stable, and is the sha256 of the shared canonical form', () => {
    expect(settingsHash(DEFAULT_PARSE_SETTINGS)).toBe(
      createHash('sha256')
        .update('{"langList":[],"llm":false,"quality":"standard"}', 'utf8')
        .digest('hex'),
    );
  });

  it('ignores language order, so one cache entry serves both requests', () => {
    expect(settingsHash({ quality: 'standard', langList: ['tr', 'en'], llm: false })).toBe(
      settingsHash({ quality: 'standard', langList: ['en', 'tr'], llm: false }),
    );
  });

  it('changes with quality — the acceptance criterion for a second docId', () => {
    expect(settingsHash({ ...DEFAULT_PARSE_SETTINGS, quality: 'advanced' })).not.toBe(
      settingsHash(DEFAULT_PARSE_SETTINGS),
    );
  });
});

describe('formatBytes', () => {
  it.each([
    [512, '512B'],
    [1024, '1KB'],
    [1536, '1.5KB'],
    [500 * 1024 * 1024, '500MB'],
  ])('renders %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
