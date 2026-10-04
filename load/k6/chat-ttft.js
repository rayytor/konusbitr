// Chat streaming: p95 time to first token, against the 1.5s budget.
//
// What is measured is `http_req_waiting` — the time from the request being
// sent to the first byte of the response stream. That is the product's own
// definition of the budget: `POST /api/chat` writes a `retrieving` event to the
// stream before it does anything else, precisely so that a reader sees the
// answer begin within the budget, and the first byte of the stream is that
// event. It is not the first token *of the model's prose*, which depends on
// the provider and is not something this instance controls.
//
// The whole stream is still read to the end, and a stream that ends without
// the model having written anything fails the check — so a server that
// answered quickly with an error does not pass as a fast one.
//
//   k6 run -e DOC_ID=doc_... load/k6/chat-ttft.js
//
// DOC_ID must be a ready document in the key's organization; without it the
// script parses the ten-page fixture once and asks about that. The key needs
// the `chat` scope (and `parse`, if it is to seed its own document).

import { check } from 'k6';
import http from 'k6/http';
import { Trend } from 'k6/metrics';
import { API_KEY, BASE_URL, JSON_HEADERS } from './lib.js';

const FIXTURE = open(__ENV.FIXTURE || '../../fixtures/pdf/clean-text-10p.pdf', 'b');

const ttft = new Trend('chat_ttft', true);
const streamDuration = new Trend('chat_stream_duration', true);

const QUESTIONS = [
  'What is this document about?',
  'Summarise the first section.',
  'What does the document say about bounding boxes?',
  'Which sections does the document have?',
];

export const options = {
  scenarios: {
    chat: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '20s', target: Number(__ENV.VUS || 10) },
        { duration: __ENV.DURATION || '1m', target: Number(__ENV.VUS || 10) },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
    chat_ttft: ['p(95)<1500'],
  },
};

export function setup() {
  if (__ENV.DOC_ID) return { docId: __ENV.DOC_ID };

  const response = http.post(
    `${BASE_URL}/v2/parse`,
    { file: http.file(FIXTURE, 'k6-chat.pdf', 'application/pdf') },
    { headers: { 'x-api-key': API_KEY }, timeout: '300s' },
  );
  if (response.status !== 200) {
    throw new Error(`setup parse failed: ${response.status} ${response.body}`);
  }
  return { docId: response.json('docId') };
}

export default function (data) {
  const response = http.post(
    `${BASE_URL}/api/chat`,
    JSON.stringify({
      documentId: data.docId,
      message: QUESTIONS[(__VU + __ITER) % QUESTIONS.length],
    }),
    { headers: JSON_HEADERS, timeout: '120s' },
  );

  const ok = check(response, {
    'chat: 200': (r) => r.status === 200,
    'chat: the stream carried text': (r) => r.status === 200 && /^event: text$/m.test(r.body),
    'chat: the stream finished': (r) => r.status === 200 && /^event: done$/m.test(r.body),
  });

  if (ok) {
    ttft.add(response.timings.waiting);
    streamDuration.add(response.timings.duration);
  }
}
