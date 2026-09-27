# konusbitr

Python client for the [Konusbitr](https://github.com/rayytor/Konusbitr) API:
parse documents, extract structured data from them, split them, and ask
questions — with page-accurate citations that are **verified against the source
before they are returned**.

```bash
pip install konusbitr
```

## Quickstart

Point it at your instance and give it a key from **Settings → API keys**.

```python
from konusbitr import Konusbitr

client = Konusbitr(
    base_url="https://konusbitr.example.com",
    api_key="kb_live_…",
)

# Parse once. The docId is a handle: every later call against it is free.
doc = client.parse(url="https://example.com/annual-report.pdf")
print(doc["pageCount"], "pages")

answer = client.ask(docId=doc["docId"], question="What was revenue in 2024?")
print(answer["answer"])

for citation in answer["citations"]:
    print(f"  page {citation['page']}: {citation['quote']}")
```

Run it against a local stack with `base_url="http://localhost:3000"`.

## Uploading a file

```python
with open("contract.pdf", "rb") as handle:
    doc = client.parse(file=handle)
```

`file`, `url` and `docId` are mutually exclusive — passing two returns a `400`
naming the conflict.

## Extracting structured data

Describe what you want with a JSON Schema. Every value comes back with the
verbatim quote that supports it, the page, and where on the page it sits.

```python
result = client.extract(
    docId=doc["docId"],
    schema={
        "type": "object",
        "properties": {
            "revenue": {"type": "string", "description": "Total revenue for the year"},
            "auditor": {"type": "string", "description": "The auditing firm"},
        },
    },
)

print(result["result"])  # {"revenue": "£1,284,567", "auditor": "…"}
print(result["unverified"])  # values whose quote was not in the document
```

`unverified` is the part worth reading. A value whose supporting quote could not
be found in the document is set to `None` in `result` and listed there with the
reason, rather than returned as though the document had said it. Writing a
`description` on each property is the cheapest thing you can do to improve an
extraction — it becomes the retrieval query for that field.

## Splitting

```python
# By page range — "1-4" and "7" are both accepted.
parts = client.split(docId=doc["docId"], ranges=["1-4", "7"])

# Or at the document's own section headings, named after them.
chapters = client.split(docId=doc["docId"], mode="semantic")
for part in chapters["documents"]:
    print(part["name"], part["pages"])
```

Each output is a real document with its own `docId`, ready to pass straight back
to `ask` or `extract`.

## Long documents

Anything long should be started asynchronously. A blocking parse of a
nine-hundred-page filing holds a connection open for minutes, and anything
between you and the API dropping it loses the result.

```python
job = client.start("parse", url="https://example.com/very-long.pdf")
doc = client.wait_for_job(job["jobId"])
```

Or be called back instead of polling:

```python
client.start(
    "parse",
    url="https://example.com/very-long.pdf",
    webhook_url="https://your-app.example.com/hooks/konusbitr",
)
```

The delivery carries `x-konusbitr-signature: v1=<hex>`, an HMAC-SHA256 over
`{timestamp}.{body}`. Verify both the signature and the timestamp's freshness;
the reference implementation is in the API repository. The result stays
available at `GET /v2/jobs/{jobId}` whether or not the webhook arrives.

## asyncio

```python
from konusbitr import AsyncKonusbitr

async with AsyncKonusbitr(base_url=..., api_key=...) as client:
    doc = await client.parse(url="https://example.com/report.pdf")
```

## Errors

Every failure is a `KonusbitrError` carrying a stable `code` you can branch on,
the HTTP `status`, machine-readable `details`, and the `request_id` to quote in a
bug report.

```python
from konusbitr import KonusbitrError, RateLimitError

try:
    client.ask(docId="doc_nope", question="…")
except RateLimitError as error:
    print("slow down for", error.retry_after_seconds, "seconds")
except KonusbitrError as error:
    if error.code == "unknown_document":
        ...
    print(error.code, error.status, error.request_id)
```

The client retries a `429`, a `5xx` and a dropped connection with exponential
backoff and full jitter. It never retries a `4xx` that is your request being
wrong — sending it again is a slower way to get the same answer.

## Migrating from PDF.ai

The API is wire-compatible with `api.pdf.ai/v2`, so an existing integration can
be repointed by changing the base URL. `client.chat_with_pdf()` and
`client.chat_with_all_pdfs()` are the legacy `/v1` endpoints, kept for migration;
prefer `ask()` for new code. The exact field-by-field guarantees are in
[`docs/api-compatibility.md`](https://github.com/rayytor/Konusbitr/blob/main/docs/api-compatibility.md).

## Generated, and kept honest

`konusbitr/_generated.py` — the types and the operation table — is produced from
the API's own OpenAPI document by `make generate`, and CI fails if it drifts. The
client around it is written by hand, because retries, backoff and job polling are
not things a specification describes.

Apache-2.0.
