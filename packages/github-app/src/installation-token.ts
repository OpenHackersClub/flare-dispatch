// @flare-dispatch/github-app — installation access-token exchange + cache.
//
// A GitHub App JWT only authenticates the *App*; to act against a repo the App
// must exchange the JWT for an *installation access token*
// (`POST /app/installations/{id}/access_tokens`). That token is per-installation
// (one installation covers every repo the App is installed on for an org), is
// scoped, and expires after ~1 hour.
//
// --- Cache: Worker-memory only (V0) -----------------------------------------
//
// V0 caches the token in a module-level `Map` keyed by installation id. This
// is *per Worker isolate* — there is no `INSTALL_TOKEN_KV` fallback. The plan
// (specs/pm/plan.md § 2 + § 6) explicitly defers the KV namespace to V1:
//
//   * V0 dispatches are caller-driven (one POST per CI run), so there is no
//     redelivery storm a shared cache would need to absorb.
//   * Recycle caveat: if the Worker isolate is evicted mid-execution, the next
//     check-run write simply does a fresh JWT exchange — one extra round-trip,
//     never a failure. Acceptable for V0 throughput; flagged for V1.
//
// The cache stores the token only while it is *fresh* — a margin is subtracted
// from the real expiry so a token that is about to expire is treated as a
// miss, never handed to a caller who would then race the expiry.
//
// Spec: specs/04-gha-integration.md § Check-runs callback, specs/pm/plan.md
// § PR6 / § 6 (token-cache eviction risk).

import { GithubApiError } from "./errors";
import { signAppJwt } from "./jwt";

/** GitHub's API host — overridable for tests / GitHub Enterprise. */
const DEFAULT_API_BASE = "https://api.github.com";

/** Treat a token as expired this many ms before its real expiry. */
const EXPIRY_MARGIN_MS = 60_000;

/** A cached installation token plus the epoch-ms it should stop being used. */
type CachedToken = {
  readonly token: string;
  /** Real GitHub expiry (epoch ms) minus {@link EXPIRY_MARGIN_MS}. */
  readonly usableUntilMs: number;
};

/**
 * Process-memory token cache, keyed by installation id. Module-level so it is
 * shared across calls within one Worker isolate — and *only* that isolate.
 */
const tokenCache = new Map<string, CachedToken>();

/** Clear the in-memory cache — test seam; never called in production. */
export const __clearTokenCache = (): void => tokenCache.clear();

/** Options for {@link getInstallationToken}. */
export type GetInstallationTokenOptions = {
  /** The numeric GitHub App id. */
  readonly appId: string | number;
  /** The App's PKCS#8 PEM private key. */
  readonly privateKeyPem: string;
  /** The installation id to mint a token for. */
  readonly installationId: string | number;
  /** API base override (tests / GHE). Defaults to `https://api.github.com`. */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Skip the cache and force a fresh exchange. */
  readonly forceRefresh?: boolean;
};

/** GitHub's `access_tokens` response — only the fields we consume. */
type AccessTokenResponse = {
  readonly token: string;
  /** ISO-8601 expiry, ~1 h out. */
  readonly expires_at: string;
};

/**
 * Resolve an installation access token, served from the in-memory cache when a
 * fresh entry exists, otherwise minted via a fresh App-JWT exchange and cached.
 *
 * @throws {GithubApiError} when the `access_tokens` endpoint returns non-2xx.
 */
export const getInstallationToken = async (
  opts: GetInstallationTokenOptions,
): Promise<string> => {
  const key = String(opts.installationId);
  const now = Date.now();

  if (!opts.forceRefresh) {
    const cached = tokenCache.get(key);
    if (cached !== undefined && cached.usableUntilMs > now) {
      return cached.token;
    }
  }

  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const doFetch = opts.fetchImpl ?? fetch;

  const jwt = await signAppJwt({
    appId: opts.appId,
    privateKeyPem: opts.privateKeyPem,
  });

  const url = `${apiBase}/app/installations/${key}/access_tokens`;
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "flare-dispatch",
    },
  });

  if (!res.ok) {
    throw new GithubApiError(
      `installation-token exchange failed`,
      res.status,
      await res.text().catch(() => ""),
    );
  }

  const body = (await res.json()) as AccessTokenResponse;
  const expiresMs = Date.parse(body.expires_at);
  tokenCache.set(key, {
    token: body.token,
    usableUntilMs: Number.isNaN(expiresMs)
      ? now + EXPIRY_MARGIN_MS // pathological: still cache briefly
      : expiresMs - EXPIRY_MARGIN_MS,
  });

  return body.token;
};
