import { describe, expect, it } from 'vitest';
import { createStorage, MULTIPART_PART_BYTES, MULTIPART_THRESHOLD_BYTES } from '../src/client.js';
import { originalKey } from '../src/keys.js';

/**
 * Presigning is pure cryptography — no network, no bucket — so what it produces
 * can be checked here. The behaviour against a real endpoint is the integration
 * test's job.
 */
const storage = createStorage({
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'konusbitr',
  accessKeyId: 'konusbitr',
  secretAccessKey: 'konusbitr-dev-secret',
  forcePathStyle: true,
});

const KEY = originalKey('org_clx1abcd2345', 'doc_clx1efgh6789', 'pdf');

describe('presignPut', () => {
  it('signs a URL the browser can PUT to without credentials of its own', async () => {
    const signed = new URL(await storage.presignPut(KEY, { contentType: 'application/pdf' }));

    expect(signed.origin).toBe('http://localhost:9000');
    // Path-style addressing: the bucket is in the path, not the hostname —
    // which is what MinIO, R2 and B2 all need.
    expect(signed.pathname).toBe(`/konusbitr/${KEY}`);
    expect(signed.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(signed.searchParams.get('X-Amz-Credential')).toContain('konusbitr');
  });

  it('expires, so a leaked URL is not a permanent write grant', async () => {
    const signed = new URL(await storage.presignPut(KEY, { expiresIn: 60 }));
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('60');
  });
});

describe('presignGet', () => {
  it('can name the file the browser saves it as, with quotes escaped', async () => {
    const signed = new URL(await storage.presignGet(KEY, { downloadAs: 'my "report".pdf' }));
    const disposition = signed.searchParams.get('response-content-disposition');

    expect(disposition).toBe('attachment; filename="my _report_.pdf"');
  });
});

describe('the multipart threshold', () => {
  it('is one part, because below that multipart only costs round trips', () => {
    expect(MULTIPART_THRESHOLD_BYTES).toBe(MULTIPART_PART_BYTES);
  });

  it('keeps a 500MB upload well inside S3’s 10,000-part ceiling', () => {
    expect(Math.ceil((500 * 1024 * 1024) / MULTIPART_PART_BYTES)).toBeLessThan(100);
  });

  it('uses parts S3 will accept — at least 5MiB each', () => {
    expect(MULTIPART_PART_BYTES).toBeGreaterThanOrEqual(5 * 1024 * 1024);
  });
});
