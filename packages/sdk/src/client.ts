import { JobFailedError, KonusbitrError, RateLimitError } from './errors.js';
import * as operations from './generated/operations.js';
import type { ApiJob } from './generated/types.js';

/**
 * The runtime half of the SDK, written by hand on purpose.
 *
 * Everything an OpenAPI document describes — the paths, the shapes, the status
 * codes — is generated into `src/generated/`. What it does *not* describe is
 * how a good client behaves: when to retry, how to back off, how to wait for an
 * asynchronous job, what to do with a `Retry-After`. A generator's guess at
 * those would be worse than a page of deliberate code, so this is that page.
 */

export type ClientOptions = {
  /** Base URL of the instance, with or without a trailing slash. */
  baseUrl: string;
  /** An API key from Settings → API keys. Sent as `X-API-Key`. */
  apiKey: string;
  /**
   * Retries for a failure that could plausibly succeed on a second try — a
   * 429, a 5xx, a dropped connection. Never for a 4xx that is the caller's
   * fault: retrying a malformed request is a slower way to get the same answer.
   */
  maxRetries?: number;
  /** Per-request timeout. A parse of a long document may legitimately exceed it. */
  timeoutMs?: number;
  /** Swap in a `fetch` for testing, or one with your own agent. */
  fetch?: typeof fetch;
};

type RequestOptions = {
  /** Return `{ jobId }` immediately instead of waiting. */
  async?: boolean;
  /** Called once with the result when an `?async=true` operation finishes. */
  webhookUrl?: string;
  signal?: AbortSignal;
};

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Full jitter, capped. See AWS's "Exponential Backoff and Jitter". */
function backoffMs(attempt: number): number {
  return Math.random() * Math.min(30_000, 500 * 2 ** attempt);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class KonusbitrClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  // ── The four v2 endpoints ─────────────────────────────────────────────────

  /** Parse a document into markdown and located elements. */
  parse(body: operations.ParseBody, options?: RequestOptions): Promise<operations.ParseResult> {
    return this.#send(operations.parse, body, options);
  }

  /** Extract structured data against a JSON Schema, with every value cited. */
  extract(
    body: operations.ExtractBody,
    options?: RequestOptions,
  ): Promise<operations.ExtractResult> {
    return this.#send(operations.extract, body, options);
  }

  /** Split a document into separate documents, by page range or by section. */
  split(body: operations.SplitBody, options?: RequestOptions): Promise<operations.SplitResult> {
    return this.#send(operations.split, body, options);
  }

  /** Ask a question and get an answer whose every claim is cited. */
  ask(body: operations.AskBody, options?: RequestOptions): Promise<operations.AskResult> {
    return this.#send(operations.ask, body, options);
  }

  // ── Documents and jobs ────────────────────────────────────────────────────

  /** A document's status and page count. Free to poll. */
  getDocument(docId: string): Promise<operations.GetDocumentResult> {
    return this.#request(operations.getDocument, { params: { docId } });
  }

  /** Delete a document, its pages, its chunks and its stored bytes. */
  deleteDocument(docId: string): Promise<operations.DeleteDocumentResult> {
    return this.#request(operations.deleteDocument, { params: { docId } });
  }

  /** One asynchronous operation. Free to poll. */
  getJob(jobId: string): Promise<ApiJob> {
    return this.#request(operations.getJob, { params: { jobId } });
  }

  // ── Legacy ────────────────────────────────────────────────────────────────

  /** @deprecated PDF.ai compatibility. Use {@link ask}. */
  chatWithPdf(body: operations.ChatWithPdfBody): Promise<operations.ChatWithPdfResult> {
    return this.#request(operations.chatWithPdf, { body });
  }

  /** @deprecated PDF.ai compatibility. Use {@link ask} with `corpus: true`. */
  chatWithAllPdfs(body: operations.ChatWithAllPdfsBody): Promise<operations.ChatWithAllPdfsResult> {
    return this.#request(operations.chatWithAllPdfs, { body });
  }

  // ── Asynchronous helpers ──────────────────────────────────────────────────

  /**
   * Start an operation without waiting, and get its job id.
   *
   * Use this rather than the synchronous call for a long document: a parse of
   * nine hundred pages holds a connection open for minutes, and anything
   * between you and the API dropping it loses the result. The job's answer is
   * durable and can be fetched later.
   */
  async startAsync<Body>(
    operation: { method: string; path: string; body: string; async: boolean },
    body: Body,
    options?: { webhookUrl?: string; signal?: AbortSignal },
  ): Promise<{ jobId: string }> {
    return this.#request(operation, {
      body: options?.webhookUrl ? { ...body, webhook_url: options.webhookUrl } : body,
      query: { async: 'true' },
      signal: options?.signal,
    });
  }

  /**
   * Poll a job until it finishes, and return its result.
   *
   * Polls at a fixed interval rather than backing off, because a caller who
   * called this is waiting and the endpoint costs nothing to read. Raises
   * {@link JobFailedError} when the operation failed, carrying the same code
   * the synchronous call would have raised.
   */
  async waitForJob(
    jobId: string,
    options: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const interval = options.intervalMs ?? 1_000;
    const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);

    for (;;) {
      const job = await this.getJob(jobId);

      if (job.status === 'succeeded') return job.result;
      if (job.status === 'failed') {
        const error = job.error;
        throw new JobFailedError(
          jobId,
          new KonusbitrError(
            error?.code ?? 'internal',
            error?.message ?? 'The operation failed.',
            500,
            error?.details,
            error?.requestId ?? '',
          ),
        );
      }

      if (Date.now() >= deadline) {
        throw new KonusbitrError(
          'timeout',
          `Job ${jobId} did not finish within the timeout.`,
          408,
          { jobId, status: job.status, progress: job.progress },
          '',
        );
      }

      await sleep(interval);
    }
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  /** Run an operation, asynchronously if asked, waiting for the result either way. */
  async #send<Body, Result>(
    operation: { method: string; path: string; body: string; async: boolean },
    body: Body,
    options?: RequestOptions,
  ): Promise<Result> {
    if (!options?.async) {
      return this.#request(operation, { body, signal: options?.signal });
    }

    const { jobId } = await this.startAsync(operation, body, {
      webhookUrl: options.webhookUrl,
      signal: options.signal,
    });
    return (await this.waitForJob(jobId, { signal: options.signal })) as Result;
  }

  async #request<Result>(
    operation: { method: string; path: string },
    options: {
      body?: unknown;
      params?: Record<string, string>;
      query?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<Result> {
    let path = operation.path;
    for (const [name, value] of Object.entries(options.params ?? {})) {
      path = path.replace(`{${name}}`, encodeURIComponent(value));
    }

    const query = new URLSearchParams(options.query ?? {}).toString();
    // Both surfaces hang off the same origin, and only the two legacy
    // operations live under `/v1`.
    const prefix = path.startsWith('/chat-with') ? '/v1' : '/v2';
    const url = `${this.#baseUrl}${prefix}${path}${query ? `?${query}` : ''}`;

    let last: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt));

      try {
        return await this.#once<Result>(url, operation.method, options.body, options.signal);
      } catch (error) {
        last = error;

        // A 4xx that is not a rate limit is the caller's request being wrong,
        // and sending it again is a slower way to get the same answer.
        if (error instanceof KonusbitrError && !error.retryable) throw error;
        if (options.signal?.aborted) throw error;
      }
    }

    throw last;
  }

  async #once<Result>(
    url: string,
    method: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Result> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;

    const response = await this.#fetch(url, {
      method,
      headers: {
        'x-api-key': this.#apiKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: combined,
    });

    const requestId = response.headers.get('x-request-id') ?? '';
    const payload = await response.json().catch(() => undefined);

    if (response.ok) return payload as Result;

    const error = KonusbitrError.from(response.status, payload, requestId);
    if (response.status === 429) {
      throw new RateLimitError(error, Number(response.headers.get('retry-after') ?? 1));
    }
    throw error;
  }
}
