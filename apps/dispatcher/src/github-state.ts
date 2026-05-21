// FlareDispatch Dispatcher — signed `state` token for the GitHub App manifest
// exchange (specs/05-byoc.md § GitHub App setup).
//
// The exchange flow is an OAuth-style handoff:
//
//   1. `GET /v1/github/start` issues a `state` and renders a form that POSTs
//      the App manifest to `https://github.com/.../settings/apps/new?state=...`.
//   2. GitHub creates the App, redirects to `GET /v1/github/installed?code=
//      <code>&state=<state>`.
//   3. The installed-handler MUST confirm the `state` it received is the one
//      `start` issued — otherwise an attacker can race-redirect a victim's
//      browser into an attacker-owned App's exchange.
//
// We use HMAC-signed state instead of a KV-stored token: stateless, no extra
// binding, ~no roundtrip. The HMAC reuses `env.HMAC_SECRET` (the same secret
// the dispatcher already trusts) with an INPUT-PREFIX namespace
// ("github-state.v1") so a state token can never be confused with a dispatch
// MAC — different input domains map to different HMAC outputs even when the
// key is shared.
//
// --- State token format ------------------------------------------------------
//
//   v1.<ts>.<nonce>.<mac>
//
//   v1   : format version (lets us rotate without breaking outstanding tokens
//          mid-flight).
//   ts   : issue time, unix seconds, decimal string.
//   nonce: 16 hex chars (8 bytes) from `crypto.getRandomValues` — collision-
//          resistant per state, makes replay logging meaningful.
//   mac  : first 32 hex chars (128 bits) of
//          HMAC-SHA256(secret, "github-state.v1." + ts + "." + nonce).
//
// All segments are dot-separated lowercase hex / decimal — URL-safe with no
// percent-encoding. Total length ≈ 70 chars.
//
// --- Freshness ---------------------------------------------------------------
//
// `ts` is rechecked on verify against `now`; tokens older than `STATE_TTL_SECS`
// are rejected even if the MAC checks out. The TTL bounds how long an
// intercepted token is replay-usable.

const STATE_VERSION = "v1";
const HMAC_NAMESPACE = `github-state.${STATE_VERSION}`;
const MAC_HEX_LEN = 32; // 128 bits — non-secret, but plenty for CSRF binding.
const NONCE_BYTES = 8;

/** Lifetime of an issued state token. The manifest exchange completes in
 *  seconds — five minutes is a comfortable upper bound for human latency. */
export const STATE_TTL_SECS = 300;

const encoder = new TextEncoder();

/** Reasons `verifyState` can reject a token. */
export type StateVerifyResult =
  | { ok: true; ts: number; nonce: string }
  | { ok: false; reason: "malformed" | "bad_version" | "bad_mac" | "expired" };

const bytesToHex = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const importKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

const macOf = async (secret: string, payload: string): Promise<string> => {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${HMAC_NAMESPACE}.${payload}`),
  );
  return bytesToHex(sig).slice(0, MAC_HEX_LEN);
};

/** 16 hex chars from 8 random bytes. */
const freshNonce = (): string => {
  const buf = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
};

/**
 * Issue a fresh state token at the given `ts` (unix seconds). `ts` is a
 * parameter — not `Date.now()` — so tests can pin time.
 */
export const signState = async (
  secret: string,
  ts: number,
  nonce: string = freshNonce(),
): Promise<string> => {
  const payload = `${ts}.${nonce}`;
  const mac = await macOf(secret, payload);
  return `${STATE_VERSION}.${payload}.${mac}`;
};

/**
 * Verify a state token. Constant-time MAC comparison (via `crypto.subtle.sign`
 * + string equality only after MAC recompute) — no per-character early-out.
 */
export const verifyState = async (
  secret: string,
  token: string,
  now: number,
): Promise<StateVerifyResult> => {
  // v1.<ts>.<nonce>.<mac>
  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [version, tsStr, nonce, macHex] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (version !== STATE_VERSION) return { ok: false, reason: "bad_version" };

  const ts = Number.parseInt(tsStr, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed" };
  if (
    !/^[0-9a-f]+$/.test(nonce) ||
    nonce.length !== NONCE_BYTES * 2 ||
    macHex.length !== MAC_HEX_LEN ||
    !/^[0-9a-f]+$/.test(macHex)
  ) {
    return { ok: false, reason: "malformed" };
  }

  const expected = await macOf(secret, `${ts}.${nonce}`);
  // The MAC values are non-secret-derived (truncation of an HMAC) and equal
  // lengths; a direct string compare here is fine — there's no per-byte secret
  // to leak.
  if (expected !== macHex) return { ok: false, reason: "bad_mac" };

  if (ts + STATE_TTL_SECS < now) return { ok: false, reason: "expired" };

  return { ok: true, ts, nonce };
};
