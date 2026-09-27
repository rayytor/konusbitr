import { describe, expect, it } from 'vitest';
import * as operations from '../src/generated/operations.js';
import { KonusbitrClient, KonusbitrError, RateLimitError } from '../src/index.js';

/**
 * The SDK's own behaviour, against a `fetch` the test controls.
 *
 * What is under test is the half that is *not* generated: the URL a call goes
 * to, how a failure becomes a typed error, when a request is retried and when
 * it is not, and how a job is waited on. All of it is written by hand, so all of
 * it needs asserting.
 */

const BASE = 'https://konusbitr.example.com';
const KEY = 'kb_test_key';

type Handler = (request: Request) => Response | Promise<Response>;

function clientWith(handler: Handler, options: { maxRetries?: number } = {}) {
  return new KonusbitrClient({
    baseUrl: BASE,
    apiKey: KEY,
    maxRetries: options.maxRetries ?? 0,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(handler(new Request(input as never, init)))) as typeof fetch,
  });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('routing', () => {
  it('sends v2 operations under /v2 and legacy ones under /v1', async () => {
    const seen: string[] = [];
    const client = clientWith((request) => {
      seen.push(request.url);
      return json(200, { docId: 'doc_1', content: '', references: [] });
    });

    await client.parse({ docId: 'doc_1' });
    await client.ask({ docId: 'doc_1', question: '?' });
    await client.chatWithPdf({ docId: 'doc_1', question: '?' });

    expect(seen).toEqual([`${BASE}/v2/parse`, `${BASE}/v2/ask`, `${BASE}/v1/chat-with-pdf`]);
  });

  it('substitutes path parameters', async () => {
    const seen: string[] = [];
    const client = clientWith((request) => {
      seen.push(request.url);
      return json(200, {});
    });

    await client.getDocument('doc_abc');
    await client.getJob('ajob_xyz');

    expect(seen).toEqual([`${BASE}/v2/documents/doc_abc`, `${BASE}/v2/jobs/ajob_xyz`]);
  });

  it('does not double a trailing slash on the base URL', async () => {
    const seen: string[] = [];
    const client = new KonusbitrClient({
      baseUrl: `${BASE}/`,
      apiKey: KEY,
      fetch: ((input: RequestInfo | URL) => {
        seen.push(String(input));
        return Promise.resolve(json(200, {}));
      }) as typeof fetch,
    });

    await client.getDocument('doc_1');
    expect(seen).toEqual([`${BASE}/v2/documents/doc_1`]);
  });

  it('sends the API key on every request', async () => {
    const client = clientWith((request) => {
      expect(request.headers.get('x-api-key')).toBe(KEY);
      return json(200, {});
    });
    await client.getDocument('doc_1');
  });
});

describe('errors', () => {
  it('turns an error envelope into a typed error', async () => {
    const client = clientWith(() =>
      json(
        400,
        {
          error: {
            code: 'input_conflict',
            message: 'Give exactly one of file, url or docId.',
            details: { given: ['url', 'docId'] },
            requestId: 'req_abc',
          },
        },
        { 'x-request-id': 'req_abc' },
      ),
    );

    await expect(client.parse({ url: 'x', docId: 'y' })).rejects.toThrow(KonusbitrError);

    const error = await client.parse({ url: 'x', docId: 'y' }).catch((e) => e as KonusbitrError);
    expect(error.code).toBe('input_conflict');
    expect(error.status).toBe(400);
    expect(error.details).toEqual({ given: ['url', 'docId'] });
    expect(error.requestId).toBe('req_abc');
    expect(error.retryable).toBe(false);
  });

  it('carries Retry-After on a 429', async () => {
    const client = clientWith(() =>
      json(
        429,
        { error: { code: 'rate_limited', message: 'Slow down.', requestId: 'req_1' } },
        { 'retry-after': '7' },
      ),
    );

    const error = await client.getDocument('doc_1').catch((e) => e as RateLimitError);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterSeconds).toBe(7);
  });

  it('still produces a typed error when the body is not the envelope', async () => {
    const client = clientWith(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const error = await client.getDocument('doc_1').catch((e) => e as KonusbitrError);

    expect(error.status).toBe(502);
    expect(error.retryable).toBe(true);
  });
});

describe('retries', () => {
  it('retries a 5xx and then succeeds', async () => {
    let attempts = 0;
    const client = clientWith(
      () => {
        attempts += 1;
        if (attempts < 3) {
          return json(503, {
            error: { code: 'upstream_unavailable', message: 'x', requestId: 'r' },
          });
        }
        return json(200, { docId: 'doc_1' });
      },
      { maxRetries: 3 },
    );

    await expect(client.getDocument('doc_1')).resolves.toEqual({ docId: 'doc_1' });
    expect(attempts).toBe(3);
  });

  it('never retries a 4xx that is the caller`s fault', async () => {
    let attempts = 0;
    const client = clientWith(
      () => {
        attempts += 1;
        return json(404, { error: { code: 'not_found', message: 'x', requestId: 'r' } });
      },
      { maxRetries: 3 },
    );

    await expect(client.getDocument('doc_1')).rejects.toThrow(KonusbitrError);
    expect(attempts).toBe(1);
  });

  it('bounds the number of attempts', async () => {
    let attempts = 0;
    const client = clientWith(
      () => {
        attempts += 1;
        return json(500, { error: { code: 'internal', message: 'x', requestId: 'r' } });
      },
      { maxRetries: 2 },
    );

    await expect(client.getDocument('doc_1')).rejects.toThrow();
    expect(attempts).toBe(3);
  });
});

describe('asynchronous operations', () => {
  it('sends async=true when asked to start one', async () => {
    const seen: string[] = [];
    const client = clientWith((request) => {
      seen.push(request.url);
      return json(202, { jobId: 'ajob_1', status: 'pending' });
    });

    await client.startAsync(operations.parse, { docId: 'doc_1' });
    expect(seen).toEqual([`${BASE}/v2/parse?async=true`]);
  });

  it('attaches a webhook url to the body', async () => {
    let body: Record<string, unknown> = {};
    const client = clientWith(async (request) => {
      body = (await request.json()) as Record<string, unknown>;
      return json(202, { jobId: 'ajob_1' });
    });

    await client.startAsync(
      operations.parse,
      { docId: 'doc_1' },
      { webhookUrl: 'https://hooks.example/x' },
    );
    expect(body.webhook_url).toBe('https://hooks.example/x');
  });

  it('polls a job until it succeeds and returns its result', async () => {
    const states = [
      { status: 'pending', progress: 0, result: null },
      { status: 'running', progress: 40, result: null },
      { status: 'succeeded', progress: 100, result: { docId: 'doc_1' } },
    ];
    let index = 0;
    const client = clientWith(() => json(200, states[index++]));

    await expect(client.waitForJob('ajob_1', { intervalMs: 0 })).resolves.toEqual({
      docId: 'doc_1',
    });
  });

  it('raises the operation`s own error when the job failed', async () => {
    const client = clientWith(() =>
      json(200, {
        status: 'failed',
        progress: 100,
        result: null,
        error: { code: 'needs_ocr', message: 'That file is a scan.', requestId: 'req_1' },
      }),
    );

    const error = await client
      .waitForJob('ajob_1', { intervalMs: 0 })
      .catch((e) => e as KonusbitrError);
    expect(error.code).toBe('needs_ocr');
  });

  it('gives up eventually rather than polling forever', async () => {
    const client = clientWith(() => json(200, { status: 'running', progress: 1, result: null }));
    const error = await client
      .waitForJob('ajob_1', { intervalMs: 0, timeoutMs: 0 })
      .catch((e) => e as KonusbitrError);
    expect(error.code).toBe('timeout');
  });

  it('runs an operation asynchronously end to end when asked', async () => {
    let call = 0;
    const client = clientWith(() => {
      call += 1;
      if (call === 1) return json(202, { jobId: 'ajob_1', status: 'pending' });
      return json(200, { status: 'succeeded', progress: 100, result: { docId: 'doc_1' } });
    });

    await expect(client.parse({ docId: 'doc_1' }, { async: true })).resolves.toEqual({
      docId: 'doc_1',
    });
  });
});

describe('the generated operation table', () => {
  it('names a method and a path for every operation', () => {
    for (const [name, operation] of Object.entries(operations)) {
      if (typeof operation !== 'object' || operation === null) continue;
      expect(operation, name).toHaveProperty('method');
      expect(operation, name).toHaveProperty('path');
    }
  });

  it('covers the four v2 endpoints and both legacy ones', () => {
    for (const name of ['parse', 'extract', 'split', 'ask', 'chatWithPdf', 'chatWithAllPdfs']) {
      expect(operations).toHaveProperty(name);
    }
  });
});
