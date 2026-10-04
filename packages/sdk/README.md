# @konusbitr/sdk

TypeScript client for the [Konusbitr](https://github.com/rayytor/Konusbitr) API:
parse documents, extract structured data from them, split them, and ask
questions — with page-accurate citations that are **verified against the source
before they are returned**.

```bash
npm install @konusbitr/sdk
```

Node 22.13+. No dependencies.

## Quickstart

Point it at your instance and give it a key from **Settings → API keys**.

```ts
import { KonusbitrClient } from '@konusbitr/sdk';

const konusbitr = new KonusbitrClient({
  baseUrl: 'https://konusbitr.example.com',
  apiKey: process.env.KONUSBITR_API_KEY!,
});

// Parse once. The docId is a handle: every later call against it is free.
const doc = await konusbitr.parse({ url: 'https://example.com/annual-report.pdf' });
console.log(doc.pageCount, 'pages');

const { answer, citations } = await konusbitr.ask({
  docId: doc.docId,
  question: 'What was revenue in 2024?',
});

console.log(answer);
for (const citation of citations) {
  console.log(`  page ${citation.page}: ${citation.quote}`);
}
```

Run it against a local stack with `baseUrl: 'http://localhost:3000'`.

## Uploading a file

```ts
import { readFile } from 'node:fs/promises';

const doc = await konusbitr.parse({
  file: { data: await readFile('contract.pdf'), filename: 'contract.pdf' },
});
```

`file`, `url` and `docId` are mutually exclusive — passing two returns a `400`
naming the conflict.

## Extracting structured data

Describe what you want with a JSON Schema. Every value comes back with the
verbatim quote that supports it, the page, and where on the page it sits.

```ts
const { result, citations, unverified } = await konusbitr.extract({
  docId: doc.docId,
  schema: {
    type: 'object',
    properties: {
      revenue: { type: 'string', description: 'Total revenue for the year' },
      auditor: { type: 'string', description: 'The auditing firm' },
    },
  },
});
```

`unverified` is the part worth reading. A value whose supporting quote could not
be found in the document is set to `null` in `result` and listed there with the
reason, rather than returned as though the document had said it. Writing a
`description` on each property is the cheapest thing you can do to improve an
extraction — it becomes the retrieval query for that field.

## Splitting

```ts
// By page range — "1-4" and "7" are both accepted.
const parts = await konusbitr.split({ docId: doc.docId, ranges: ['1-4', '7'] });

// Or at the document's own section headings, named after them.
const chapters = await konusbitr.split({ docId: doc.docId, mode: 'semantic' });
```

Each output is a real document with its own `docId`, ready to pass straight back
to `ask` or `extract`.

## Long documents

Anything long should be run asynchronously. A blocking parse of a nine-hundred
page filing holds a connection open for minutes, and anything between you and the
API dropping it loses the result.

```ts
// Start it, wait for it, and get the same body the blocking call would return.
const doc = await konusbitr.parse({ url: '…' }, { async: true });

// Or hand it off and be called back.
const { jobId } = await konusbitr.startAsync(
  operations.parse,
  { url: '…' },
  { webhookUrl: 'https://your-app.example.com/hooks/konusbitr' },
);
```

The delivery carries `x-konusbitr-signature: v1=<hex>`, an HMAC-SHA256 over
`{timestamp}.{body}`. Verify both the signature and the timestamp's freshness.
The result stays available at `GET /v2/jobs/{jobId}` whether or not the webhook
arrives, so you can also just poll:

```ts
const result = await konusbitr.waitForJob(jobId);
```

## Errors

Every failure is a `KonusbitrError` carrying a stable `code` you can switch on,
the HTTP `status`, machine-readable `details`, and the `requestId` to quote in a
bug report.

```ts
import { KonusbitrError, RateLimitError } from '@konusbitr/sdk';

try {
  await konusbitr.ask({ docId: 'doc_nope', question: '…' });
} catch (error) {
  if (error instanceof RateLimitError) {
    console.log('slow down for', error.retryAfterSeconds, 'seconds');
  } else if (error instanceof KonusbitrError) {
    if (error.code === 'unknown_document') { /* … */ }
    console.log(error.code, error.status, error.requestId);
  }
}
```

The client retries a `429`, a `5xx` and a dropped connection with exponential
backoff and full jitter. It never retries a `4xx` that is your request being
wrong — sending it again is a slower way to get the same answer.

## Migrating from PDF.ai

The API is wire-compatible with `api.pdf.ai/v2`, so an existing integration can
be repointed by changing the base URL. `chatWithPdf()` and `chatWithAllPdfs()`
are the legacy `/v1` endpoints, kept for migration; prefer `ask()` for new code.
The exact field-by-field guarantees are in
[`docs/api-compatibility.md`](https://github.com/rayytor/Konusbitr/blob/main/docs/api-compatibility.md).

## Generated, and kept honest

`src/generated/` — the types and the operation table — is produced from the API's
own OpenAPI document by `pnpm generate`, and CI fails if it drifts. The client
around it is written by hand, because retries, backoff and job polling are not
things a specification describes.

Apache-2.0.
