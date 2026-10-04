// `/v2/parse` throughput.
//
// Two scenarios, because "how fast is parse" is two different questions.
//
// `cold` uploads bytes the instance has never seen — each iteration appends a
// unique trailing comment to the fixture, which changes its SHA-256 and so
// misses the docId cache while leaving the PDF valid (a reader stops at
// `%%EOF`). That measures the pipeline: intake, queue, worker, Docling. It is
// a closed loop of `COLD_VUS` callers, each waiting for its parse before
// sending the next, and the default matches the worker's default
// `WORKER_CONCURRENCY` of two. That is deliberate: an open arrival rate above
// what the worker pool can clear measures how long a queue grows in a minute,
// not how long a parse takes. Throughput is `parse_pages` per second.
//
// `cached` asks for a document that is already parsed, by `docId`. That is the
// call an integration makes thousands of times, it does no work by design, and
// its budget is the one in the phase file: a repeat parse returns *instantly*.
//
//   k6 run load/k6/parse.js
//   k6 run -e COLD_VUS=4 -e CACHED_VUS=50 load/k6/parse.js
//
// Rate limits apply to load tests like anything else. Either raise
// RATE_LIMIT_PER_KEY_PER_MINUTE / RATE_LIMIT_PER_ORG_PER_MINUTE on the instance
// under test or set RATE_LIMIT_ENABLED=false there; a 429 is counted as a
// failure here on purpose, so a throttled run cannot pass for a fast one.

import { check } from 'k6';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import { API_KEY, BASE_URL, JSON_HEADERS } from './lib.js';

const FIXTURE = open(__ENV.FIXTURE || '../../fixtures/pdf/clean-text-10p.pdf', 'b');

const coldDuration = new Trend('parse_cold_duration', true);
const cachedDuration = new Trend('parse_cached_duration', true);
const pagesParsed = new Counter('parse_pages');

export const options = {
  scenarios: {
    cold: {
      executor: 'constant-vus',
      exec: 'cold',
      vus: Number(__ENV.COLD_VUS || 2),
      duration: __ENV.DURATION || '1m',
    },
    cached: {
      executor: 'constant-vus',
      exec: 'cached',
      vus: Number(__ENV.CACHED_VUS || 20),
      duration: __ENV.DURATION || '1m',
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    // A ten-page born-digital document, against a budget of 20s for fifty.
    parse_cold_duration: ['p(95)<20000'],
    // No job, no model call, one row read and one object read.
    parse_cached_duration: ['p(95)<500'],
  },
};

/** The fixture with a unique trailer, so its hash is new and the cache misses. */
function uniqueDocument() {
  const suffix = `\n% k6 ${__VU}-${__ITER}-${Date.now()}-${Math.random()}\n`;
  const original = new Uint8Array(FIXTURE);
  const bytes = new Uint8Array(original.length + suffix.length);
  bytes.set(original, 0);
  for (let i = 0; i < suffix.length; i++) bytes[original.length + i] = suffix.charCodeAt(i);
  return bytes.buffer;
}

export function setup() {
  // One real parse up front: the document the `cached` scenario reads, and the
  // cost of loading the worker's models paid before anything is measured.
  const response = http.post(
    `${BASE_URL}/v2/parse`,
    { file: http.file(FIXTURE, 'k6-seed.pdf', 'application/pdf') },
    { headers: { 'x-api-key': API_KEY }, timeout: '300s' },
  );
  if (response.status !== 200) {
    throw new Error(`setup parse failed: ${response.status} ${response.body}`);
  }
  return { docId: response.json('docId') };
}

export function cold() {
  const response = http.post(
    `${BASE_URL}/v2/parse`,
    { file: http.file(uniqueDocument(), 'k6-cold.pdf', 'application/pdf') },
    { headers: { 'x-api-key': API_KEY }, timeout: '120s', tags: { scenario: 'cold' } },
  );

  const ok = check(response, {
    'cold: 200': (r) => r.status === 200,
    'cold: not served from cache': (r) => r.status === 200 && r.json('cached') === false,
  });
  if (ok) {
    coldDuration.add(response.timings.duration);
    pagesParsed.add(response.json('pageCount'));
  }
}

export function cached(data) {
  const response = http.post(`${BASE_URL}/v2/parse`, JSON.stringify({ docId: data.docId }), {
    headers: JSON_HEADERS,
    tags: { scenario: 'cached' },
  });

  const ok = check(response, {
    'cached: 200': (r) => r.status === 200,
    'cached: served from cache': (r) => r.status === 200 && r.json('cached') === true,
  });
  if (ok) cachedDuration.add(response.timings.duration);
}
