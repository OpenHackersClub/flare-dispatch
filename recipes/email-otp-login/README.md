# email-otp-login

Provision a **fresh user through an OTP / magic-link login** — against an
OTP-based auth provider (Auth0, Clerk, Stytch, Supabase) or your own app — with
no seeded fixture user and no shared mailbox. This is the worked example of the
**`mailbox` capability**: a self-hosted, disposable inbox on Cloudflare Email
Routing, so a test/demo can complete email-verification flows end to end.

```
provision demo-<rand>@INBOX_DOMAIN   →  POST /otp/start (email it)
   →  email lands in your Email Routing catch-all → email() handler
   →  handler signals the paused run  →  waitForOtp extracts the code/link
   →  POST /otp/verify (or follow the link)  →  green / red check
```

## How it works

The `email-otp-login` run (`runs/email-otp-login.ts`; teaching copy here as
`email-otp-login.run.ts`) drives the flow **API-level** — no browser:

1. `provisionInbox()` mints `demo-<rand>@<INBOX_DOMAIN>` and records a durable
   `localPart → executionId` row.
2. `curl` POSTs the address to the auth API's "start" endpoint.
3. `waitForOtp({ inbox })` **hibernates** the run on `step.waitForEvent` — zero
   CPU while waiting. The provider's email lands in your Email Routing catch-all,
   the dispatcher's `email()` handler parses it and `sendEvent`s the message back
   to this exact run.
4. The run extracts the OTP **code** (or **magic link**) and `curl`s the "verify"
   endpoint. A non-success status fails the run red with a readable summary.

Why event-driven, not polling: `io.sleep` isn't replay-safe in a CF Workflow;
`step.waitForEvent` is the codebase's correct "hibernate until a signal" seam.

## One-time operator setup

> **Automated:** steps 2–3 (enable Email Routing + the catch-all rule) are an
> idempotent script — `CLOUDFLARE_API_TOKEN=… scripts/setup-inbox-routing.sh
> --apply` (dry-run without `--apply`). It needs a token scoped **Email Routing
> Rules/Addresses : Edit + DNS : Edit** on the zone (the *deploy* token is not
> enough). Step 4 is a `wrangler.jsonc` edit. The manual breakdown:

1. **Pick a dedicated inbox host** — e.g. `inbox.openhackers.club`. Do **not**
   use a zone apex that carries real mail: a catch-all routes *everything* on the
   host to the Worker (the handler rejects non-`demo-` RCPTs, but a dedicated host
   keeps the blast radius small).
2. **Enable Email Routing** on that host and add a **catch-all rule → the
   dispatcher Worker** (dashboard → Email → Routing Rules → Catch-all → *Send to a
   Worker*, or `wrangler email routing`). Inbound has **no verified-destination
   constraint** — that only gates the outbound `send_email`/`forward` — so any
   `demo-*` local-part is received with no per-address setup.
3. **Set `INBOX_DOMAIN`** in `wrangler.jsonc` `vars` to that host and redeploy.
4. *(Recommended)* set `INBOX_ALLOWED_SENDERS` to the provider's sending domains
   (`auth0.com,clerk.com,…`) so the handler only stores mail from expected
   senders.
5. *(Optional)* set a dedicated `MAILBOX_LINK_SECRET` to rotate the read-route
   token independently of `HMAC_SECRET`.

The migration `infra/migrations/0004_inbox.sql` (applied on deploy) adds the
`inbox_allocations` + `inbox_messages` tables.

## Run it

Set repo vars/secrets `FLAREDISPATCH_ENDPOINT` + `FLAREDISPATCH_HMAC`, then use
`ci.yml` (Action mode) — `workflow_dispatch` with a `base_url`, or the nightly
cron against `vars.AUTH_BASE_URL`. Tune per provider via the inputs JSON:

| input | default | notes |
|---|---|---|
| `baseURL` | — | auth API origin; empty ⇒ the run is a logged no-op |
| `startPath` / `startBody` | `/api/auth/otp/start`, `{"email":"{{email}}"}` | the "send me a code" call; `{{email}}` is the provisioned address |
| `verifyPath` / `verifyBody` | `/api/auth/otp/verify`, `{"email":"{{email}}","code":"{{code}}"}` | the "here's my code" call |
| `codePattern` | context-anchored numeric | override regex (first capture group) |
| `linkHost` | — | for magic links, prefer URLs on the provider's auth host |
| `expectStatus` | `200` | success status from verify |
| `waitSeconds` | `120` | raise for providers with slow mail |

## Providers

- **Real provider (Auth0/Clerk/Stytch/Supabase):** their mail is DKIM-signed, so
  it passes Email Routing's inbound auth check and lands. **Turn OFF the tenant's
  "block disposable email" toggle** (it's your own tenant) and **only ever drive
  your own tenant**. Treat real-provider runs as best-effort / allowed-to-skip:
  provider-side velocity heuristics can throttle a single domain.
- **Generic self-hosted target:** `demo-form/` is a tiny OTP API (`/otp/start`,
  `/otp/verify`) you can deploy as the `baseURL`. **Note the sender constraint:**
  Cloudflare's `send_email` can't deliver to disposable addresses, so the demo
  form sends via Resend (a DKIM-signed domain Email Routing then receives). See
  `demo-form/README.md`.

## Browser driver (alternative)

The shipped run is API-level. To drive a real login **form**, run a Playwright
spec inside a sandbox that fills the email, submits, then **polls the read
route** for the code:

```
GET /v1/mailbox/<localPart>?exp=<epoch>&t=<token>   →  { code, link, text, … }
```

The run passes `inbox.localPart` + `inbox.token` + `inbox.expiresAtS` into the
container. The route is **token-only** (a container can't carry an Access JWT)
and **burns the message on first read**, with a short-lived expiring token — see
`apps/dispatcher/src/routes/mailbox.ts`.

## Testing & CI honesty

The offline gate does **not** rely on a live email hop (which needs DNS + a
sender). It's covered by:

- `runs/email-otp-login.test.ts` — the full provision → start → `waitForOtp` →
  verify loop, with the inbox event injected into the inline runner (standing in
  for the `email()` handler's `sendEvent`) and the auth API canned.
- `apps/dispatcher/src/routes/email-handler.test.ts` — fixture-MIME injected
  straight into the `email()` handler (reject-before-parse, text-only store,
  signal).
- `apps/dispatcher/src/routes/mailbox.test.ts` — read-route token gating +
  burn-after-read.

A genuine live receive (MX → CF → handler) is a separate, credentialed,
allowed-to-skip integration run.

## Security posture

- **Reject-before-parse:** the `email()` handler `setReject`s any RCPT that isn't
  a minted `demo-…` address *before* buffering the body.
- **Text-only at rest:** the HTML alternative (where magic links also live) is
  not stored — it's account-takeover material.
- **Expiring token + burn-after-read:** the read-route token expires and the
  message is consumed on first read, so a leaked container-env token replays to
  nothing.
- **Tight TTL:** allocations and messages expire (default 10 min).
