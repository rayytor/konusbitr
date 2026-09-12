import { createHash, randomBytes } from 'node:crypto';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStorage, MULTIPART_PART_BYTES, type Storage } from '../../src/client.js';
import { documentPrefix, originalKey, pageThumbnailKey } from '../../src/keys.js';

/**
 * The storage layer against a real MinIO.
 *
 * Presigning is cryptography and can be checked offline; everything else about
 * an S3-compatible endpoint — whether a presigned PUT is actually accepted,
 * whether multipart assembles, whether `ETag` comes back, whether a prefix
 * delete really removes a document's whole tree — can only be learned by
 * talking to one. MinIO is the endpoint a self-hoster gets, so it is the one
 * this runs against.
 */

const ROOT_USER = 'konusbitr-root';
const ROOT_PASSWORD = 'konusbitr-root-secret';
const BUCKET = 'konusbitr-test';

const ORG = 'org_clx1abcd2345';
const DOC = 'doc_clx1efgh6789';

let container: StartedTestContainer;
let storage: Storage;

beforeAll(async () => {
  const { GenericContainer, Wait } = await import('testcontainers');

  container = await new GenericContainer('quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z')
    .withCommand(['server', '/data'])
    .withEnvironment({
      MINIO_ROOT_USER: ROOT_USER,
      MINIO_ROOT_PASSWORD: ROOT_PASSWORD,
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
    .start();

  storage = createStorage({
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    region: 'us-east-1',
    bucket: BUCKET,
    accessKeyId: ROOT_USER,
    secretAccessKey: ROOT_PASSWORD,
    forcePathStyle: true,
  });

  await storage.client.send(new CreateBucketCommand({ Bucket: BUCKET }));
}, 240_000);

afterAll(async () => {
  await container?.stop();
}, 60_000);

/** Write a small object through the ordinary client, for fixtures. */
async function seed(key: string, text: string) {
  const { Readable } = await import('node:stream');
  await storage.uploadStream(key, Readable.from([Buffer.from(text, 'latin1')]));
}

/** PUT with a plain `fetch`, exactly as a browser would: no credentials at all. */
async function putAsBrowser(url: string, body: Uint8Array, contentType?: string) {
  const response = await fetch(url, {
    method: 'PUT',
    body,
    ...(contentType ? { headers: { 'content-type': contentType } } : {}),
  });
  if (!response.ok) throw new Error(`presigned PUT failed: ${response.status}`);
  return response.headers.get('etag');
}

describe('a presigned single PUT', () => {
  const key = originalKey(ORG, DOC, 'pdf');
  const body = Buffer.from('%PDF-1.7\nhello\n%%EOF\n', 'latin1');

  it('lets an unauthenticated client write the object', async () => {
    const url = await storage.presignPut(key, { contentType: 'application/pdf' });
    await putAsBrowser(url, body, 'application/pdf');

    const head = await storage.head(key);
    expect(head?.byteSize).toBe(body.length);
    expect(head?.contentType).toBe('application/pdf');
  });

  it('can be read back as a stream, which is how it gets hashed', async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.streamGet(key)) chunks.push(Buffer.from(chunk));

    expect(Buffer.concat(chunks)).toEqual(body);
  });

  it('is readable through a presigned GET, and nothing else', async () => {
    const signed = await storage.presignGet(key);
    expect(await (await fetch(signed)).arrayBuffer()).toEqual(body.buffer.slice(0, body.length));

    const unsigned = new URL(signed);
    unsigned.search = '';
    expect((await fetch(unsigned)).status).toBe(403);
  });

  it('reports a missing object as null rather than throwing', async () => {
    expect(await storage.head(originalKey(ORG, 'doc_clx1nope0000', 'pdf'))).toBeNull();
  });
});

describe('a presigned multipart upload', () => {
  /**
   * Two 16MiB parts and a small remainder.
   *
   * The same code path a 200MB file takes — only the part count differs — and
   * the point of running it at all is that not one of these bytes goes through
   * a server: every part is PUT straight to storage from a presigned URL.
   */
  const key = originalKey(ORG, 'doc_clx1multipart', 'pdf');
  const body = randomBytes(MULTIPART_PART_BYTES * 2 + 1024);

  it('assembles parts the client uploaded directly into one object', async () => {
    const ticket = await storage.presignMultipart(key, body.length, {
      contentType: 'application/pdf',
    });

    expect(ticket.parts).toHaveLength(3);

    const uploaded: { partNumber: number; etag: string }[] = [];
    for (const part of ticket.parts) {
      const start = (part.partNumber - 1) * ticket.partSize;
      const slice = body.subarray(start, Math.min(start + ticket.partSize, body.length));

      const etag = await putAsBrowser(part.url, slice);
      // Multipart is impossible without this header reaching the browser, which
      // is why the bucket's CORS policy has to expose it.
      expect(etag, 'storage must return an ETag for each part').toBeTruthy();
      uploaded.push({ partNumber: part.partNumber, etag: etag as string });
    }

    await storage.completeMultipart(key, ticket.uploadId, uploaded);

    const head = await storage.head(key);
    expect(head?.byteSize).toBe(body.length);
  });

  it('reassembles byte for byte', async () => {
    const hash = createHash('sha256');
    for await (const chunk of await storage.streamGet(key)) hash.update(chunk);

    expect(hash.digest('hex')).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('can be abandoned without leaving an object behind', async () => {
    const abandoned = originalKey(ORG, 'doc_clx1abandoned', 'pdf');
    const ticket = await storage.presignMultipart(abandoned, MULTIPART_PART_BYTES * 2);

    await storage.abortMultipart(abandoned, ticket.uploadId);
    expect(await storage.head(abandoned)).toBeNull();
  });
});

describe('uploadStream', () => {
  it('writes a stream without buffering it, which is what URL import needs', async () => {
    const key = originalKey(ORG, 'doc_clx1fromurl0', 'pdf');
    const body = randomBytes(1024 * 64);

    const { Readable } = await import('node:stream');
    await storage.uploadStream(key, Readable.from([body]), { contentType: 'application/pdf' });

    expect((await storage.head(key))?.byteSize).toBe(body.length);
    await storage.delete(key);
  });
});

describe('deleting a document', () => {
  it('removes every object under its prefix, not just the original', async () => {
    const doc = 'doc_clx1deleteme';
    await seed(originalKey(ORG, doc, 'pdf'), 'original');
    await seed(pageThumbnailKey(ORG, doc, 1), 'page one');
    await seed(pageThumbnailKey(ORG, doc, 2), 'page two');

    const removed = await storage.deletePrefix(documentPrefix(ORG, doc));

    expect(removed).toBe(3);
    expect(await storage.head(originalKey(ORG, doc, 'pdf'))).toBeNull();
    expect(await storage.head(pageThumbnailKey(ORG, doc, 1))).toBeNull();
  });

  it('leaves another document in the same organization alone', async () => {
    expect(await storage.head(originalKey(ORG, DOC, 'pdf'))).not.toBeNull();
  });
});
