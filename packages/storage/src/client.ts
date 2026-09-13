import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * The S3-compatible storage client.
 *
 * One interface over MinIO, S3, R2 and B2, because a self-hoster's MinIO and a
 * hosted deployment's S3 must exercise the same code path — the only difference
 * between them is `S3_ENDPOINT` and whether path-style addressing is needed.
 *
 * The load-bearing property of this module is that **document bytes never pass
 * through the Next.js server**. Uploads are presigned and PUT by the browser
 * directly; the server only ever sees the small control-plane calls (`head`,
 * `delete`) and the one streaming read it needs to hash an object it did not
 * receive. A 500MB upload costs the web process a few hundred bytes of JSON.
 */

export type StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and most non-AWS endpoints address buckets by path, not subdomain. */
  forcePathStyle: boolean;
  /**
   * The endpoint a **browser** can reach, when that differs from the one this
   * process reaches.
   *
   * In Compose the web container talks to `http://minio:9000`, a hostname that
   * resolves on the Docker network and nowhere else. A presigned URL signed
   * against it is useless to the browser it is handed to, and the failure is
   * silent from the app's side: the upload or the viewer simply never connects.
   * SigV4 signs the `Host` header, so the URL cannot be rewritten after the
   * fact — it has to be *signed* against the public origin, which is why this
   * is a second client rather than a string replace.
   *
   * Unset (the ordinary S3/R2/B2 case, and a natively-run dev stack) means the
   * two are the same endpoint.
   */
  publicEndpoint?: string | undefined;
};

/** How long a presigned URL stays valid. Long enough for a slow 500MB upload. */
const DEFAULT_PRESIGN_TTL_SECONDS = 60 * 60;

/**
 * Part size for multipart uploads.
 *
 * S3 requires every part except the last to be at least 5MiB and allows at most
 * 10,000 parts. 16MiB keeps a 500MB upload to 32 parts — few enough to presign
 * them all in one response — while staying small enough that a dropped
 * connection re-sends little.
 */
export const MULTIPART_PART_BYTES = 16 * 1024 * 1024;

/**
 * Uploads at or below this size are a single PUT.
 *
 * Multipart costs an extra round trip to open the upload and another to
 * complete it; below one part there is nothing to gain from paying them.
 */
export const MULTIPART_THRESHOLD_BYTES = MULTIPART_PART_BYTES;

export type HeadResult = {
  byteSize: number;
  contentType: string | undefined;
  etag: string | undefined;
  lastModified: Date | undefined;
};

export type MultipartTicket = {
  uploadId: string;
  partSize: number;
  /** One presigned PUT per part, in order. */
  parts: { partNumber: number; url: string }[];
};

/** What the client reports back after PUTting a part. */
export type CompletedPart = { partNumber: number; etag: string };

/** How many objects `DeleteObjects` accepts in one call. */
const DELETE_BATCH_SIZE = 1000;

export function createStorage(config: StorageConfig) {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  /**
   * The client every *presigned* URL is signed with.
   *
   * Identical to `client` unless `publicEndpoint` says otherwise; see the note
   * on that field for why a second client is the only correct implementation.
   */
  const signer =
    config.publicEndpoint && config.publicEndpoint !== config.endpoint
      ? new S3Client({
          endpoint: config.publicEndpoint,
          region: config.region,
          forcePathStyle: config.forcePathStyle,
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        })
      : client;

  const bucket = config.bucket;

  return {
    /** The underlying client, for the rare command this facade does not wrap. */
    client,
    bucket,

    /** A URL the browser can PUT one object to, without any credentials. */
    presignPut(
      key: string,
      options: { contentType?: string; expiresIn?: number } = {},
    ): Promise<string> {
      return getSignedUrl(
        signer,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(options.contentType ? { ContentType: options.contentType } : {}),
        }),
        { expiresIn: options.expiresIn ?? DEFAULT_PRESIGN_TTL_SECONDS },
      );
    },

    /**
     * A URL the browser can GET one object from.
     *
     * This is how the viewer loads a PDF in Phase 11: the bytes go from storage
     * to the browser, never through the app.
     */
    presignGet(
      key: string,
      options: { expiresIn?: number; downloadAs?: string; inlineAs?: string } = {},
    ): Promise<string> {
      const disposition = options.downloadAs
        ? `attachment; filename="${options.downloadAs.replace(/["\\]/g, '_')}"`
        : options.inlineAs
          ? `inline; filename="${options.inlineAs.replace(/["\\]/g, '_')}"`
          : undefined;
      return getSignedUrl(
        signer,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          // Quoted and with quotes/backslashes escaped: the value is a filename
          // that originally came from a user, and it must stay data.
          ...(disposition ? { ResponseContentDisposition: disposition } : {}),
        }),
        { expiresIn: options.expiresIn ?? DEFAULT_PRESIGN_TTL_SECONDS },
      );
    },

    /**
     * Object metadata, or `null` when it is not there.
     *
     * This is what confirms a presigned upload actually happened and matches
     * the size the client declared — the client is not trusted to tell us that
     * it finished.
     */
    async head(key: string): Promise<HeadResult | null> {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          byteSize: Number(result.ContentLength ?? 0),
          contentType: result.ContentType,
          etag: result.ETag,
          lastModified: result.LastModified,
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    /** Remove one object. Succeeds whether or not it was there. */
    async delete(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    /**
     * Remove everything under a prefix.
     *
     * Deleting a document has to remove its original, its thumbnails and its
     * extracted images, and the row that listed them is already gone by the
     * time this runs — so the prefix, not a manifest, is the source of truth.
     */
    async deletePrefix(prefix: string): Promise<number> {
      let removed = 0;
      let continuationToken: string | undefined;

      do {
        const listed = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
            MaxKeys: DELETE_BATCH_SIZE,
          }),
        );

        const keys = (listed.Contents ?? [])
          .map((object) => object.Key)
          .filter((key): key is string => Boolean(key));

        if (keys.length > 0) {
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
            }),
          );
          removed += keys.length;
        }

        continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (continuationToken);

      return removed;
    },

    /**
     * Read an object as a stream.
     *
     * Streaming rather than buffering is not a micro-optimization here: this is
     * how a 500MB object is hashed and validated in a web process that must
     * never hold it in memory.
     */
    async streamGet(key: string): Promise<Readable> {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = result.Body;
      if (!body) throw new Error(`storage object ${key} has no body`);
      if (body instanceof Readable) return body;
      return Readable.fromWeb(
        body.transformToWebStream() as Parameters<typeof Readable.fromWeb>[0],
      );
    },

    /**
     * Write a stream to storage, using multipart when it turns out to be large.
     *
     * This is the *only* path where bytes flow through the app, and it exists
     * for one reason: URL import has no browser to presign for. The stream is
     * never buffered — `Upload` sends each part as it fills — so importing a
     * 200MB URL costs a part-sized slice of memory, not 200MB.
     */
    async uploadStream(
      key: string,
      body: Readable,
      options: { contentType?: string; partSize?: number } = {},
    ): Promise<void> {
      const upload = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: key,
          Body: body,
          ...(options.contentType ? { ContentType: options.contentType } : {}),
        },
        partSize: options.partSize ?? MULTIPART_PART_BYTES,
        queueSize: 2,
      });
      await upload.done();
    },

    /**
     * Open a multipart upload and presign every part in one go.
     *
     * Presigning the parts up front, rather than handing out one at a time,
     * means the browser can upload them in parallel and retry a failed part
     * without another round trip to us.
     */
    async presignMultipart(
      key: string,
      byteSize: number,
      options: { contentType?: string; expiresIn?: number; partSize?: number } = {},
    ): Promise<MultipartTicket> {
      const partSize = options.partSize ?? MULTIPART_PART_BYTES;
      const expiresIn = options.expiresIn ?? DEFAULT_PRESIGN_TTL_SECONDS;

      const created = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ...(options.contentType ? { ContentType: options.contentType } : {}),
        }),
      );

      const uploadId = created.UploadId;
      if (!uploadId) throw new Error(`storage did not return an upload id for ${key}`);

      const partCount = Math.max(1, Math.ceil(byteSize / partSize));
      const parts = await Promise.all(
        Array.from({ length: partCount }, async (_unused, index) => {
          const partNumber = index + 1;
          const url = await getSignedUrl(
            signer,
            new UploadPartCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
            }),
            { expiresIn },
          );
          return { partNumber, url };
        }),
      );

      return { uploadId, partSize, parts };
    },

    /** Assemble the parts the browser uploaded into one object. */
    async completeMultipart(
      key: string,
      uploadId: string,
      parts: readonly CompletedPart[],
    ): Promise<void> {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
          },
        }),
      );
    },

    /** Throw away a multipart upload so its parts stop costing storage. */
    async abortMultipart(key: string, uploadId: string): Promise<void> {
      await client.send(
        new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
      );
    },
  };
}

export type Storage = ReturnType<typeof createStorage>;

/** S3 reports a missing object as 404/`NotFound`; every other error is real. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'NotFound' || candidate.$metadata?.httpStatusCode === 404;
}
