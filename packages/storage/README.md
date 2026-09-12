# `@konusbitr/storage`

The S3-compatible object store: MinIO locally, S3, R2 or B2 in production. The
only difference between them is `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE`.

```ts
import { createStorage, originalKey } from '@konusbitr/storage';

const storage = createStorage({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle });
const key = originalKey(orgId, documentId, 'pdf');
const url = await storage.presignPut(key, { contentType: 'application/pdf' });
```

## Key layout

```
orgs/{orgId}/documents/{docId}/original.{ext}
orgs/{orgId}/documents/{docId}/pages/{n}.webp        # thumbnails, Phase 07
orgs/{orgId}/documents/{docId}/images/{n}.png        # extracted images, Phase 12
```

Every segment is a generated id. `keys.ts` refuses to build a key from anything
that does not look like one, so an uploaded filename can never become a path —
it is stored as a label in `documents.filename` and never reaches this package.

## Why presigning matters

Document bytes never pass through the Next.js server. The browser PUTs directly
to storage — one PUT under 16MiB, presigned multipart above it — and the server
sees only the control-plane calls. That is what makes a 500MB upload cost the
web process a few hundred bytes of JSON rather than 500MB of heap.

The one streaming read the server does perform is `streamGet`, used to compute
an object's SHA-256 and validate it after upload. It is a stream, never a
buffer, for the same reason.

## Tests

`pnpm --filter @konusbitr/storage test` covers the key builders and the shape of
what is signed, without a network. `pnpm --filter @konusbitr/storage
test:integration` runs the whole surface — single PUT, multipart, head, stream,
prefix delete — against a real MinIO in Testcontainers, and needs Docker.
