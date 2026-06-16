// FlareDispatch Dispatcher — per-execution agent model-proxy capability tokens.
//
// The model-proxy (`POST /v1/agent/:execution/inference`) lets an in-sandbox
// coding agent reach a model WITHOUT holding a model API key — the Worker (which
// holds the AI binding) brokers the call. The agent authenticates with a
// capability token bound to its execution id, minted by the run and injected as
// `$FLARE_MODEL_PROXY` auth. Same construction as the log-viewer token
// (`log-token.ts`) — HKDF-derived, HMAC over the execution id — but a DISTINCT
// `info` label so an agent token can never be confused with, or forged from, a
// log token even though both can derive from `HMAC_SECRET`.
//
// The token authenticates; the *state* (liveness, remaining budget, rate limit)
// lives in the AgentBudget DO — a stateless token can't hold it (security review
// #1). A leaked token therefore buys, at most, that execution's remaining budget.
//
// Spec: specs/08-self-healing.md § 6.3, § 10.2.

import type { Env } from "./env";

const encoder = new TextEncoder();

/** Domain-separation label — DISTINCT from the log token's. */
const HKDF_INFO = "flare-dispatch/agent-proxy/v1";

/** 22 base64url chars ≈ 132 bits — matches the log-token strength. */
const TOKEN_CHARS = 22;

/**
 * Key material for the agent token: a dedicated `AGENT_PROXY_SECRET`, else the
 * shared `HMAC_SECRET` (present on every Action-mode deploy). The HKDF label
 * keeps the derived key independent of both the raw dispatch HMAC and the log
 * token. Neither set ⇒ `undefined` ⇒ the route default-denies (503).
 */
export const resolveAgentProxySecret = (env: Env): string | undefined => {
  const dedicated = env.AGENT_PROXY_SECRET;
  if (typeof dedicated === "string" && dedicated.length > 0) return dedicated;
  const hmac = env.HMAC_SECRET;
  if (typeof hmac === "string" && hmac.length > 0) return hmac;
  return undefined;
};

const base64url = (bytes: ArrayBuffer): string => {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const deriveKey = async (ikm: string): Promise<CryptoKey> => {
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(ikm),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode(HKDF_INFO),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
};

/** Mint the agent capability token for `executionId`. */
export const signAgentToken = async (
  ikm: string,
  executionId: string,
): Promise<string> => {
  const key = await deriveKey(ikm);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(executionId) as BufferSource,
  );
  return base64url(mac).slice(0, TOKEN_CHARS);
};

const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Verify a presented token for `executionId` (constant-time). */
export const verifyAgentToken = async (
  ikm: string,
  executionId: string,
  presented: string | null | undefined,
): Promise<boolean> => {
  if (typeof presented !== "string" || presented.length !== TOKEN_CHARS) {
    return false;
  }
  const expected = await signAgentToken(ikm, executionId);
  return safeEqual(expected, presented);
};

/** Extract a bearer token from the Authorization header (or `?token=`). */
export const callerAgentToken = (request: Request, url: URL): string | null => {
  const auth = request.headers.get("authorization");
  if (auth !== null) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m !== null) return m[1]!.trim();
  }
  return url.searchParams.get("token");
};
