# Generic OTP demo target

A tiny self-contained OTP login API + form, so you can run `email-otp-login`
end-to-end against something you control. Deploys as its own Worker.

## Endpoints

- `GET  /` — a two-step HTML form (email → code).
- `POST /api/auth/otp/start`  `{ email }` → mints a 6-digit code (KV, 10-min
  TTL) and emails it.
- `POST /api/auth/otp/verify` `{ email, code }` → `200` on match (single-use),
  else `401`.

## The sender constraint (important)

Cloudflare's `send_email` binding can only deliver to **verified Email Routing
destination addresses** — it **cannot** email the disposable `demo-…@inbox`
addresses the recipe provisions. So this demo sends via **Resend** from a
DKIM-signed domain, which Email Routing then *receives* into the catch-all
(inbound has no verified-destination constraint).

- Set `RESEND_API_KEY` (`wrangler secret put RESEND_API_KEY`) + `RESEND_FROM`.
- **Without** a sender configured, `/otp/start` returns the code as `devCode` in
  its JSON so the API is still smoke-testable — but that path does **not**
  exercise the email receive loop, which is the point. Use it only for a quick
  API check, not as proof the inbound path works.

## Deploy

```sh
wrangler kv namespace create OTP_KV     # paste the id into wrangler.jsonc
wrangler secret put RESEND_API_KEY
# set RESEND_FROM in wrangler.jsonc vars
wrangler deploy
```

Then point the recipe at it: `email-otp-login` input `baseURL` = this Worker's
URL. The provisioned address must be on the `INBOX_DOMAIN` catch-all so the
Resend-sent mail lands back in the dispatcher's `email()` handler.
