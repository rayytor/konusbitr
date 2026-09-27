# Wire compatibility with `api.pdf.ai`

Konusbitr's public API is shaped so that an existing PDF.ai integration can be
repointed by changing one base URL. This file is the **declaration of what that
means** — the field names and types we commit to, endpoint by endpoint — and it
is not prose: `apps/web/test/v2/compat.test.ts` asserts the real Zod schemas
against the table below, field for field, so a rename that would break somebody
else's integration cannot be merged quietly.

Three rules govern everything here.

**Upstream's names win, including where they are inconsistent.** `docId` and
`lang_list` and `system_prompt` appear in the same request object. That is not
sloppiness; it is what compatibility *is*. Our own camelCase spellings are
accepted as aliases (`langList`, `systemPrompt`, `webhookUrl`,
`documentId`) and are applied before validation, with the documented name
winning whenever both are sent. The snake_case names are the contract and are
what `docs/openapi.json` describes.

**We add, we never replace.** Every response below is upstream's shape plus
fields upstream does not have. A client that reads only the fields it knows
about sees exactly the response it expects; a client that reads the rest gets a
citation it can draw on a page. Nothing in the tables below is ever removed or
retyped.

**Where we improve, we improve additively.** `?async=true` and `webhook_url` are
ours. Upstream is synchronous only, which means a caller parsing a nine-hundred
page filing holds a connection open for the duration and loses the result if
anything between them and us blinks. Adding an optional query parameter cannot
break a client that never sends it.

## Input selection

Every document-taking endpoint accepts exactly one of:

| Field   | Type                      | Notes |
| ------- | ------------------------- | ----- |
| `file`  | binary (`multipart/form-data`) | The document itself. |
| `url`   | string                    | Fetched server-side, through the SSRF guard. |
| `docId` | string                    | A document already in this organization. Free: no upload, no parse, no credits. |

Supplying two of them is a `400` whose `error.code` is `input_conflict` and
whose `details.given` names both. Supplying none is `input_missing`. This is
stricter than "last one wins" on purpose: a caller who sends a `url` alongside a
stale `docId` would otherwise be answered about a document they did not ask
about, with no way to notice.

## `POST /v2/parse`

**Request**

| Field         | Type                       | Ours? |
| ------------- | -------------------------- | ----- |
| `file`/`url`/`docId` | see above           | no    |
| `quality`     | `"standard"` \| `"advanced"` | no  |
| `lang_list`   | `string[]`                 | no    |
| `llm`         | `boolean`                  | no    |
| `filename`    | `string`                   | yes — names a `url` import |
| `webhook_url` | `string`                   | yes   |

**Response**

| Field       | Type               | Ours? |
| ----------- | ------------------ | ----- |
| `docId`     | `string`           | no    |
| `markdown`  | `string`           | no    |
| `contents`  | `ParsedElement[]`  | no    |
| `images`    | `ExtractedImage[]` | no    |
| `pageCount` | `integer`          | no    |
| `cached`    | `boolean`          | yes — true when the parse cache served it and nothing was charged |

Every `ParsedElement` carries `page` and `bbox`. The box is in Konusbitr's one
coordinate convention — PDF points, origin top-left, y downward, unrotated page
— documented in `docs/coordinates.md`.

## `POST /v2/extract`

**Request**

| Field           | Type     | Ours? |
| --------------- | -------- | ----- |
| `file`/`url`/`docId` | see above | no |
| `schema`        | JSON Schema object | no |
| `system_prompt` | `string` | no    |
| `quality`, `lang_list` | as `parse` | no |
| `webhook_url`   | `string` | yes   |

**Response**

| Field        | Type         | Ours? |
| ------------ | ------------ | ----- |
| `docId`      | `string`     | no    |
| `result`     | object       | no    |
| `citations`  | `Citation[]` | no    |
| `unverified` | array        | yes   |

`unverified` is the one place this API is deliberately louder than upstream. A
leaf value whose supporting quote could not be found in the document is set to
`null` in `result` and listed here with the reason. A caller who sees a field
missing needs to be able to tell "the document does not say" from "the model
said something we would not stand behind", and silence cannot express the
difference.

## `POST /v2/split`

**Request**

| Field    | Type                                            | Ours? |
| -------- | ----------------------------------------------- | ----- |
| `file`/`url`/`docId` | see above                           | no    |
| `ranges` | `(string \| { start, end, name? })[]`           | the object form is ours |
| `mode`   | `"ranges"` \| `"semantic"`                      | no    |
| `level`  | `integer` 1–4                                   | yes — heading depth for `semantic` |

`"1-4"` and `"7"` are upstream's range spellings and both are accepted. The
object form exists so a caller can name an output, which upstream has no way to
do.

**Response**

| Field       | Type                                   | Ours? |
| ----------- | -------------------------------------- | ----- |
| `docId`     | `string` — the document that was split | yes   |
| `documents` | `{ docId, name, pages }[]`             | no    |

`pages` lists the parent page numbers the output covers.

## `POST /v2/ask`

**Request**

| Field      | Type      | Ours? |
| ---------- | --------- | ----- |
| `file`/`url`/`docId` | see above | no |
| `question` | `string`  | no    |
| `language` | `string`  | no    |
| `corpus`   | `boolean` | yes — ask across every document |

**Response**

| Field       | Type         | Ours? |
| ----------- | ------------ | ----- |
| `answer`    | `string`     | no    |
| `citations` | `Citation[]` | no    |
| `docId`     | `string \| null` | yes |

## `POST /v1/chat-with-pdf` and `POST /v1/chat-with-all-pdfs`

The legacy surface, kept for migration and nothing else. New code should use
`/v2/ask`.

**Request**: `url` or `docId` (or `docIds` for the corpus variant), plus
`question` — upstream's older spelling `prompt` is accepted as an alias — and an
optional `language`.

**Response**

| Field        | Type                | Ours? |
| ------------ | ------------------- | ----- |
| `content`    | `string`            | no    |
| `references` | `LegacyReference[]` | no    |

A `LegacyReference` is `{ page }` — upstream's shape — plus `quote`, `docId` and
`bbox`. A client reading only `page` is unaffected.

One limitation, stated rather than hidden: on `/v1/chat-with-all-pdfs`, `docIds`
filters the *citations* rather than the search. Corpus retrieval scopes by
folder, not by an arbitrary id list, and threading a variadic filter through the
hot path of every corpus query to serve a compatibility shim would be paying for
it in the wrong place. A caller who needs a real restriction should ask per
document.

## Errors

Upstream's error bodies are not a documented contract, so this is ours:

```json
{ "error": { "code": "input_conflict", "message": "…", "details": { }, "requestId": "req_…" } }
```

`code` is from a closed, stable set (`API_ERROR_CODES` in
`packages/shared/src/api-v2.ts`) and is what a client should switch on. The
status is determined by the code through one table, so an endpoint cannot return
a 404 for `invalid_request` even by accident. `requestId` is on every error and
matches the `X-Request-Id` response header.

## Asynchronous operation

Adding `?async=true` to `parse`, `extract`, `split` or `ask` returns `202` with
`{ jobId, status, kind, docId }` immediately. Poll `GET /v2/jobs/{jobId}`, or
pass a `webhook_url` to be called once on completion.

A webhook delivery carries `x-konusbitr-signature: v1=<hex>` — HMAC-SHA256 over
`{timestamp}.{body}` — alongside `x-konusbitr-timestamp`,
`x-konusbitr-webhook-id` and `x-konusbitr-attempt`. Verify both the signature and
the timestamp's freshness; the reference implementation is `verifyWebhook` in
`apps/web/src/lib/v2/webhooks.ts`. Deliveries are retried four times over about
half a minute and then given up on, because the same body stays available at
`GET /v2/jobs/{jobId}` for as long as the organization exists.
