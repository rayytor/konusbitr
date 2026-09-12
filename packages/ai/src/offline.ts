import {
  type Env,
  isLocalProvider,
  type LlmProvider,
  LOCAL_LLM_PROVIDERS,
} from '@konusbitr/shared';

/**
 * Offline mode, enforced at the call site.
 *
 * `EnvSchema` already refuses to boot a process whose configuration names a
 * cloud provider while `OFFLINE_MODE=true`. This is the second enforcement, and
 * it is not redundant: configuration can change under a running process — a
 * `kubectl set env`, a rewritten `.env` and a reload, a role resolved from a
 * per-request override in a later phase — and a guarantee that only holds until
 * the next deploy is not the guarantee legal, medical and government users
 * installed this software for.
 *
 * The failure is loud and immediate, before any bytes are assembled into a
 * request body. Nothing is retried, nothing is degraded, and nothing falls back
 * to a cloud endpoint: the whole point is that the document does not leave.
 */
export class OfflineModeError extends Error {
  override readonly name = 'OfflineModeError';

  constructor(
    readonly provider: LlmProvider,
    readonly endpoint: string,
  ) {
    super(
      `OFFLINE_MODE is on and ${provider} at ${endpoint} is not a local endpoint. ` +
        `Configure ${LOCAL_LLM_PROVIDERS.join(' or ')} instead. ` +
        'Refusing the call rather than sending document text off this machine.',
    );
  }
}

/**
 * Hostnames that cannot leave the deployment.
 *
 * Compared by shape rather than resolved, for the same reason the boot check
 * is: this runs in the hot path of every model call, and a DNS lookup per call
 * would be both slow and a second thing that can fail. A bare hostname with no
 * dot is a container or service name, which is by construction not a public DNS
 * name. The resolving, SSRF-grade guard is
 * `apps/web/src/lib/ingest/ssrf.ts`, and it exists for a different job:
 * user-supplied URLs. These endpoints come from the operator's own `.env`.
 */
export function isLocalEndpoint(endpoint: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    return false;
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '::1' || hostname === '[::1]') return true;
  if (!hostname.includes('.')) return true;

  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [a = 0, b = 0] = octets;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Raise unless this endpoint may be called under the current configuration.
 *
 * Both halves have to hold: the provider must be one Konusbitr calls local, and
 * the URL it resolved to must actually be a local address. Checking only the
 * provider would let `OLLAMA_BASE_URL=https://ollama.somebody-elses-cloud.com`
 * through, which is a cloud call wearing a local provider's name.
 */
export function assertReachable(
  env: Pick<Env, 'OFFLINE_MODE'>,
  provider: LlmProvider,
  endpoint: string,
): void {
  if (!env.OFFLINE_MODE) return;
  if (isLocalProvider(provider) && isLocalEndpoint(endpoint)) return;
  throw new OfflineModeError(provider, endpoint);
}
