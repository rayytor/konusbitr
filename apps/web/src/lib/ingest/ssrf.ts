import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';

/**
 * Fetching a URL the user chose, without becoming a proxy into our own network.
 *
 * `POST /api/documents/from-url` hands an attacker a request originating from
 * inside the deployment. On a cloud host that reaches the instance metadata
 * service; in a Compose stack it reaches Postgres, Redis and MinIO; behind a
 * corporate firewall it reaches everything. So this module is written as a
 * guard first and a fetch second.
 *
 * Three properties matter, and only the third is hard:
 *
 * 1. **Only `http` and `https`.** `file:`, `gopher:` and friends are refused
 *    before anything is resolved.
 * 2. **Every hop is re-checked.** Redirects are followed manually, capped at
 *    three, and each new URL goes through the same guard as the first.
 * 3. **The address that is checked is the address that is connected to.**
 *    Resolving a hostname, deciding it is public, and then handing the hostname
 *    to a socket is the classic DNS-rebinding hole: nothing stops the second
 *    resolution from returning `127.0.0.1`. Node's `http.request` takes a
 *    `lookup` option, so the vetted address is pinned into the connection
 *    itself — there is no second resolution to rebind.
 *
 * Everything is injectable (`resolve`, `open`) so the rejected classes can be
 * tested without a network and without a cooperating attacker.
 */

export class SsrfError extends Error {
  override readonly name = 'SsrfError';
  constructor(
    message: string,
    readonly reason: SsrfReason,
  ) {
    super(message);
  }
}

export type SsrfReason =
  | 'invalid-url'
  | 'blocked-scheme'
  | 'blocked-address'
  | 'unresolvable'
  | 'too-many-redirects'
  | 'too-large'
  | 'timeout'
  | 'bad-status'
  | 'credentials-in-url';

/** Why a particular address is refused. `public` is the only acceptable answer. */
export type AddressClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'metadata'
  | 'shared'
  | 'reserved'
  | 'multicast'
  | 'unique-local'
  | 'unspecified';

function ipv4Octets(address: string): [number, number, number, number] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });

  if (octets.some((value) => Number.isNaN(value) || value > 255)) return null;
  const [a, b, c, d] = octets as [number, number, number, number];
  return [a, b, c, d];
}

/**
 * What kind of address this is.
 *
 * Written as an explicit table rather than a list of CIDRs so that each range
 * carries the reason it is refused. `169.254.169.254` is called out separately
 * from the rest of link-local because it is the single most valuable target an
 * SSRF has: on AWS, GCP and Azure it hands out credentials to anyone inside.
 */
export function classifyAddress(address: string): AddressClass {
  const normalized = address.trim().toLowerCase();

  // IPv4-mapped and IPv4-compatible IPv6 (`::ffff:169.254.169.254`) are just
  // IPv4 wearing a hat; classify the address inside.
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) return classifyAddress(mapped[1]);

  // NAT64 (64:ff9b::/96) embeds an IPv4 address in its low 32 bits.
  const nat64 = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (nat64?.[1]) return classifyAddress(nat64[1]);

  const octets = ipv4Octets(normalized);
  if (octets) {
    const [a, b, c, d] = octets;
    if (a === 0) return 'unspecified'; // 0.0.0.0/8 — "this network"
    if (a === 127) return 'loopback'; // 127.0.0.0/8
    if (a === 10) return 'private'; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16.0.0/12
    if (a === 192 && b === 168) return 'private'; // 192.168.0.0/16
    if (a === 169 && b === 254) {
      return c === 169 && d === 254 ? 'metadata' : 'link-local'; // 169.254.0.0/16
    }
    if (a === 100 && b >= 64 && b <= 127) return 'shared'; // 100.64.0.0/10, CGNAT
    if (a === 192 && b === 0 && c === 0) return 'reserved'; // 192.0.0.0/24
    if (a === 192 && b === 0 && c === 2) return 'reserved'; // TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // benchmarking
    if (a === 198 && b === 51 && c === 100) return 'reserved'; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return 'reserved'; // TEST-NET-3
    if (a >= 224 && a <= 239) return 'multicast'; // 224.0.0.0/4
    if (a >= 240) return 'reserved'; // 240.0.0.0/4 and 255.255.255.255
    return 'public';
  }

  if (!normalized.includes(':')) return 'reserved'; // not an address at all

  if (normalized === '::') return 'unspecified';
  if (normalized === '::1') return 'loopback';

  const head = normalized.split(':')[0] ?? '';
  const leading = Number.parseInt(head || '0', 16);

  if ((leading & 0xfe00) === 0xfc00) return 'unique-local'; // fc00::/7
  if ((leading & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  if ((leading & 0xff00) === 0xff00) return 'multicast'; // ff00::/8

  return 'public';
}

export function isBlockedAddress(address: string): boolean {
  return classifyAddress(address) !== 'public';
}

/** Resolves a hostname to every address it has. Injectable for tests. */
export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Parse and sanity-check a URL before anything is resolved.
 *
 * Credentials in the URL are refused outright. They are not a security hole on
 * their own, but a `http://user:password@host/` that we fetch and log is a
 * credential leak we invited, and no legitimate document link carries one.
 */
export function parseIngestUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SsrfError('That does not look like a URL.', 'invalid-url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('Only http and https URLs can be imported.', 'blocked-scheme');
  }

  if (url.username || url.password) {
    throw new SsrfError(
      'Remove the credentials from the URL before importing it.',
      'credentials-in-url',
    );
  }

  if (!url.hostname) {
    throw new SsrfError('That URL has no host.', 'invalid-url');
  }

  return url;
}

const REFUSAL: Record<Exclude<AddressClass, 'public'>, string> = {
  loopback: 'resolves to a loopback address',
  private: 'resolves to a private network address',
  'link-local': 'resolves to a link-local address',
  metadata: 'resolves to the cloud metadata service',
  shared: 'resolves to a carrier-grade NAT address',
  reserved: 'resolves to a reserved address',
  multicast: 'resolves to a multicast address',
  'unique-local': 'resolves to a unique-local address',
  unspecified: 'resolves to an unspecified address',
};

/**
 * Resolve a hostname and refuse it unless **every** address it has is public.
 *
 * Every, not any: a name that resolves to one public address and one private
 * one is refused, because which one a connection gets is not ours to choose.
 */
export async function resolvePublicHost(
  hostname: string,
  resolve: Resolver = systemResolver,
): Promise<string> {
  // A bare IP literal in the URL never reaches DNS; classify it directly.
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (/^[\d.]+$/.test(literal) || literal.includes(':')) {
    const kind = classifyAddress(literal);
    if (kind !== 'public') {
      throw new SsrfError(
        `That URL ${REFUSAL[kind]}, which cannot be imported.`,
        'blocked-address',
      );
    }
    return literal;
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new SsrfError(`"${hostname}" could not be resolved.`, 'unresolvable');
  }

  if (addresses.length === 0) {
    throw new SsrfError(`"${hostname}" could not be resolved.`, 'unresolvable');
  }

  for (const { address } of addresses) {
    const kind = classifyAddress(address);
    if (kind !== 'public') {
      throw new SsrfError(
        `That URL ${REFUSAL[kind]}, which cannot be imported.`,
        'blocked-address',
      );
    }
  }

  // The first address is what gets pinned into the socket, so the address we
  // just approved is the address that is connected to.
  const first = addresses[0];
  if (!first) throw new SsrfError(`"${hostname}" could not be resolved.`, 'unresolvable');
  return first.address;
}

// ─── The fetch itself ────────────────────────────────────────────────────────

export type OpenedResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  /** The body, as chunks. Consumed exactly once, or discarded with `cancel`. */
  body: AsyncIterable<Uint8Array>;
  cancel: () => void;
};

/**
 * Opens one request, with no redirect following of its own.
 *
 * The seam exists so tests can drive the redirect and streaming logic without a
 * server. The real implementation is below.
 */
export type Opener = (
  url: URL,
  options: { pinnedAddress: string; timeoutMs: number },
) => Promise<OpenedResponse>;

const nodeOpener: Opener = (url, { pinnedAddress, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

    const request = send(
      url,
      {
        method: 'GET',
        // The vetted address, pinned. Node calls this instead of resolving the
        // hostname again, which is what closes the rebinding window: there is
        // no second DNS answer for an attacker to change.
        lookup: (_hostname, options, callback) => {
          const family = pinnedAddress.includes(':') ? 6 : 4;
          if (typeof options === 'object' && options.all) {
            callback(null, [{ address: pinnedAddress, family }] as never);
            return;
          }
          callback(null, pinnedAddress as never, family);
        },
        headers: {
          // TLS still validates against the hostname, which is why `Host` and
          // `servername` stay as written rather than following the address.
          accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.5',
          'user-agent': 'Konusbitr/0.0 (+https://github.com/rayytor/Konusbitr)',
          'accept-encoding': 'identity',
        },
        timeout: timeoutMs,
      },
      (response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers as Record<string, string | undefined>,
          body: response as unknown as AsyncIterable<Uint8Array>,
          cancel: () => (response as unknown as Readable).destroy(),
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new SsrfError('The download timed out.', 'timeout'));
    });
    request.on('error', (error) => {
      reject(
        error instanceof SsrfError
          ? error
          : new SsrfError('That URL could not be fetched.', 'unresolvable'),
      );
    });
    request.end();
  });

export type FetchRemoteOptions = {
  /** Hard ceiling on the response body. Enforced while streaming, not after. */
  maxBytes: number;
  /** Wall-clock budget for the whole thing, redirects included. */
  timeoutMs?: number;
  maxRedirects?: number;
  resolve?: Resolver;
  open?: Opener;
};

export type RemoteDocument = {
  /**
   * The body, capped and deadline-enforced, as chunks.
   *
   * A stream rather than a buffer: the caller hashes it, validates it and
   * uploads it to object storage in one pass, so a 200MB import costs the web
   * process a chunk at a time instead of 200MB of heap.
   */
  body: AsyncIterable<Uint8Array>;
  contentType: string | undefined;
  /** The URL the bytes actually came from, after any redirects. */
  finalUrl: string;
  /** From `Content-Disposition`, when the server offered one. */
  filename: string | undefined;
  /** Abandon the download. Safe to call after the body has been consumed. */
  cancel: () => void;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REDIRECTS = 3;

/**
 * Fetch a remote document, refusing anything that points inward.
 *
 * The byte cap is enforced *while* streaming rather than from
 * `Content-Length`: a hostile server will happily declare 1KB and send
 * gigabytes, so the declared length is only an early "don't bother", and the
 * running total is what actually stops the read.
 */
export async function fetchRemoteDocument(
  rawUrl: string,
  options: FetchRemoteOptions,
): Promise<RemoteDocument> {
  const resolver = options.resolve ?? systemResolver;
  const open = options.open ?? nodeOpener;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let url = parseIngestUrl(rawUrl);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (Date.now() >= deadline) throw new SsrfError('The download timed out.', 'timeout');

    // Re-run for every hop, not just the first. A redirect to a private address
    // is the standard way past a guard that only checks the URL it was given.
    const pinnedAddress = await resolvePublicHost(url.hostname, resolver);
    const response = await open(url, { pinnedAddress, timeoutMs: deadline - Date.now() });

    if (response.status >= 300 && response.status < 400) {
      response.cancel();
      const location = response.headers.location;
      if (!location) {
        throw new SsrfError('That URL redirected without saying where.', 'bad-status');
      }
      if (hop === maxRedirects) {
        throw new SsrfError('That URL redirected too many times.', 'too-many-redirects');
      }
      url = parseIngestUrl(new URL(location, url).toString());
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      response.cancel();
      throw new SsrfError(`That URL returned HTTP ${response.status}.`, 'bad-status');
    }

    const declared = Number(response.headers['content-length'] ?? Number.NaN);
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      response.cancel();
      throw new SsrfError('That file is larger than the upload limit.', 'too-large');
    }

    return {
      body: capped(response, options.maxBytes, deadline),
      contentType: response.headers['content-type']?.split(';')[0]?.trim(),
      finalUrl: url.toString(),
      filename: filenameFromDisposition(response.headers['content-disposition']),
      cancel: response.cancel,
    };
  }

  throw new SsrfError('That URL redirected too many times.', 'too-many-redirects');
}

/** The response body, cut off the moment it exceeds the cap or the deadline. */
async function* capped(
  response: OpenedResponse,
  maxBytes: number,
  deadline: number,
): AsyncIterable<Uint8Array> {
  let total = 0;

  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      response.cancel();
      throw new SsrfError('That file is larger than the upload limit.', 'too-large');
    }
    if (Date.now() > deadline) {
      response.cancel();
      throw new SsrfError('The download timed out.', 'timeout');
    }
    yield chunk;
  }
}

/** `attachment; filename="report.pdf"` → `report.pdf`. Best effort. */
export function filenameFromDisposition(header: string | undefined): string | undefined {
  if (!header) return undefined;

  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // A malformed encoding is not worth failing the import over.
    }
  }

  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim();
}
