# Security Policy

## Supported versions

Konusbitr is pre-1.0 and moving quickly. Only the latest `main` and the most
recent tagged release receive security fixes.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's private vulnerability reporting: open the
repository's **Security** tab and choose **Report a vulnerability**. That creates
a private advisory visible only to you and the maintainers.

Please include:

- what the issue is and which component it affects (web app, API, worker,
  storage, infrastructure),
- the version or commit you tested,
- a minimal reproduction, and
- what an attacker gets out of it.

We aim to acknowledge a report within three working days and to ship a fix or a
concrete plan within 30 days. We will credit you in the advisory unless you ask
us not to.

## Scope

Konusbitr is self-hosted software, so the interesting boundaries are:

- **Tenancy.** Any path that lets one organisation read another's documents,
  chunks, chats, or API keys. `org_id` scoping is a security control, not an
  ergonomic one.
- **API keys and auth.** Key generation, hashing, rotation, and revocation.
- **Untrusted document content.** Document text is data, never instructions. A
  document that causes the system to execute something, exfiltrate data, or
  reach an unintended network endpoint is a vulnerability.
- **Uploads and storage.** Presigned URL scope, path traversal, and storage keys
  derived from user input.
- **Offline mode.** `OFFLINE_MODE=true` must make any non-local model endpoint
  raise immediately. A way around that is a vulnerability.

Out of scope: vulnerabilities in a deployment's own misconfiguration (an
unauthenticated Postgres exposed to the internet, for example), denial of
service through sheer volume, and findings that require an already-compromised
host.

## Deployment hardening

Self-hosting means you own the perimeter. At minimum: do not expose Postgres,
Redis, or object storage outside the application network; set every secret in
`.env` rather than keeping the defaults from `.env.example`; and terminate TLS
in front of the web app.
