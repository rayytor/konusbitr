// The README's quickstart, runnable.
//
//   KONUSBITR_API_KEY=kb_live_... node quickstart.mjs path/to/document.pdf
//
// KONUSBITR_URL defaults to a local stack. Set KONUSBITR_QUESTION to also ask
// the document something, which needs a chat model configured on the instance.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { KonusbitrClient } from '@konusbitr/sdk';

const path = process.argv[2];
if (!path || !process.env.KONUSBITR_API_KEY) {
  console.error('usage: KONUSBITR_API_KEY=... node quickstart.mjs <document.pdf>');
  process.exit(2);
}

const konusbitr = new KonusbitrClient({
  baseUrl: process.env.KONUSBITR_URL ?? 'http://localhost:3000',
  apiKey: process.env.KONUSBITR_API_KEY,
  timeoutMs: 300_000,
});

// Parse once. The docId is a handle: every later call against it is free.
const doc = await konusbitr.parse({
  file: { data: await readFile(path), filename: basename(path) },
});
console.log(`${doc.docId}: ${doc.pageCount} pages, ${doc.contents.length} elements`);

const again = await konusbitr.parse({ docId: doc.docId });
console.log(`again by docId: cached=${again.cached}`);

const stored = await konusbitr.getDocument(doc.docId);
console.log(`status: ${stored.status}`);

if (process.env.KONUSBITR_QUESTION) {
  const { answer, citations } = await konusbitr.ask({
    docId: doc.docId,
    question: process.env.KONUSBITR_QUESTION,
  });
  console.log(answer);
  for (const citation of citations) {
    console.log(`  page ${citation.page}: ${citation.quote}`);
  }
}
