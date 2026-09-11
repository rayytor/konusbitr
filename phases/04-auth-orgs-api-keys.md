# Phase 04 — Auth, Organizations, and API Keys

**Goal:** every request into Konusbitr — browser session or API key — resolves to
an authenticated principal scoped to exactly one organization, enforced in one
place that later phases cannot bypass.

## Context

Konusbitr has two front doors: the web app (session cookies) and the public `/v2`
API (`X-API-Key`). Both must land on the same `AuthContext`, because Phase 13's
API endpoints and the app's own routes share the same handlers underneath.
Organizations are the tenancy boundary for documents, chunks, credits, and billing.

## Scope

### 1. Better Auth

Configure Better Auth against the Drizzle adapter with:
- Email + password (with verification), magic links.
- OAuth: Google and GitHub, both optional and skipped cleanly when their env vars
  are absent — a self-hoster with no OAuth app must still get a working login.
- Session cookies: httpOnly, secure in production, sane rotation.
- The organization plugin: on first signup, auto-create a personal org and an
  `owner` membership.

### 2. `AuthContext`

A single resolver used by every protected route:

```ts
type AuthContext = {
  kind: "session" | "apiKey";
  userId?: string;         // absent for API-key principals
  orgId: string;
  role: "owner" | "admin" | "member";
  scopes: string[];        // API keys only; sessions get all scopes
};
```

Resolution order: `X-API-Key` header → session cookie → 401. It must be
impossible to reach a data-access function without an `AuthContext`; enforce with
a wrapper (`withAuth(handler)`) and a lint rule or test that asserts every route
file under the protected trees uses it.

### 3. API keys

- Generated as `kb_live_<32 random chars>`; **shown once**, stored as a SHA-256
  hash with a searchable `prefix` for display and lookup.
- Scopes: `parse`, `extract`, `split`, `ask`, `chat`, `documents:read`,
  `documents:write`. Phase 13 checks these per endpoint.
- Revocation and optional expiry; `last_used_at` updated at most once per minute
  to avoid a write per request.
- UI: `/settings/api-keys` — create, name, copy-once, list with prefix and last
  used, revoke with confirmation.

### 4. Teams

- Invite by email (token link), accept flow, role changes, member removal.
- Role gates: `owner` — billing, delete org; `admin` — members, API keys, settings;
  `member` — documents and chats only.
- An org switcher in the app shell; the active org is stored in the session and is
  the `orgId` for every subsequent request.

### 5. Security requirements

- Rate-limit login, signup, magic link, and invite-accept (Redis token bucket).
- Constant-time comparison for key hashes.
- Never log a raw key, password, or session token — add a redaction test.
- CSRF protection on all cookie-authenticated mutations.

## Non-goals

Billing/Stripe (optional module, Phase 13), SSO/SAML (Phase 15+).

## Acceptance criteria

- [ ] Signup → verify → login → logout works with email/password, and with Google
      and GitHub when configured.
- [ ] With no OAuth env vars set, the login page renders and works without errors.
- [ ] A new signup automatically owns exactly one organization.
- [ ] A created API key authenticates a request; after revocation the same key 401s.
- [ ] A key lacking a required scope gets 403 with a message naming the scope.
- [ ] An `admin` cannot delete the org; an `owner` can.
- [ ] Automated test: every protected route resolves an `AuthContext`; a route
      added without `withAuth` fails the test.
- [ ] Brute-forcing login trips the rate limiter.
