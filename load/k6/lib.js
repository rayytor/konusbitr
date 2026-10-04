// Shared configuration for the k6 scripts.
//
// Everything comes from the environment so the same script runs against a
// laptop, the Compose stack and a staging deployment without an edit:
//
//   KONUSBITR_URL      base URL of the instance   (default http://localhost:3000)
//   KONUSBITR_API_KEY  a key holding the scopes the script needs (required)

export const BASE_URL = (__ENV.KONUSBITR_URL || 'http://localhost:3000').replace(/\/$/, '');
export const API_KEY = __ENV.KONUSBITR_API_KEY;

if (!API_KEY) {
  throw new Error('Set KONUSBITR_API_KEY to a key created under Settings → API keys.');
}

export const JSON_HEADERS = { 'x-api-key': API_KEY, 'content-type': 'application/json' };
