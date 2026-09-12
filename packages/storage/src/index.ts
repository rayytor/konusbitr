/**
 * `@konusbitr/storage` — the S3-compatible object store.
 *
 * Two things live here and nothing else: how a key is built (`keys.ts`) and how
 * bytes are moved (`client.ts`). Both exist to keep one invariant true — that
 * document bytes go straight between the browser and the object store, and the
 * Next.js server only ever handles the presigned URLs that let them.
 */

export type {
  CompletedPart,
  HeadResult,
  MultipartTicket,
  Storage,
  StorageConfig,
} from './client.js';
export {
  createStorage,
  MULTIPART_PART_BYTES,
  MULTIPART_THRESHOLD_BYTES,
} from './client.js';
export {
  documentImageKey,
  documentPrefix,
  originalKey,
  pageThumbnailKey,
  StorageKeyError,
} from './keys.js';
