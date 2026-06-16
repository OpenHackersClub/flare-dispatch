#!/usr/bin/env node
// signals/v1 collector — HyperDX.
//
// Contract: emits a `signals/v1` array (see packages/core/src/signals.ts and
// recipes/signals-collectors/README.md). This is a CONSUMER-side reference
// adapter — the FlareDispatch Dispatcher stays vendor-blind and never queries
// HyperDX. Drop this into a daily GHA job and feed its stdout to the
// `ci-triage-pr` run's `signals` input.
//
// THE DEGENERATE-BUT-HONEST CASE: HyperDX has no public event-search API, so
// this adapter cannot count errors itself. Instead — once the operator has
// pointed it at their workspace via HYPERDX_APP_URL — it emits ONE deep
// `level:error` SEARCH-LINK signal so the triage PR links a human straight to
// the live search for the window. When HYPERDX_API_KEY is set it ALSO best-
// effort queries the alerts management API and adds one signal per alert that
// is in an alerting/triggered state. See the README "honest degenerate" note.
//
// Env vars:
//   HYPERDX_APP_URL  (required to emit the search link) HyperDX app base, e.g.
//                    "https://www.hyperdx.io" or your self-hosted app origin.
//                    Unset → the adapter degrades to [] (it has no workspace to
//                    link to), honouring the no-config degradation contract.
//   HYPERDX_ENV      (optional) deployment/env to scope the search query to
//                    (added as `service:<env>` / `deployment.environment:<env>`).
//   HYPERDX_API_KEY  (optional) personal/ingestion API key. When set, the
//                    adapter also queries https://api.hyperdx.io alerts.
//
// Window: --since <dur> (e.g. 24h), default 24h — encoded into the search link.
//
// Degradation rules (the producer contract — see README):
//   - stdout is ONLY the JSON `Signal[]`. All diagnostics go to stderr.
//   - ALWAYS exit 0 with a valid (possibly empty) array.
//   - With NO env set the adapter degrades to [] — there is no workspace URL to
//     link to. Once HYPERDX_APP_URL is set, the credential-free search-link
//     signal is always emitted. The alerts source degrades to nothing
//     INDEPENDENTLY on missing key, a non-2xx response, or an unexpected shape.
//   - One signal per firing alert (a cluster), not per raw event.
//
// Dependency-free: Node >= 20, global `fetch` only. No package.json deps.
// Copy-paste-able as a single file — the ~20 lines of cap helpers below are
// intentionally duplicated per adapter rather than shared (see README tradeoff).

// --- signals/v1 caps (mirror of packages/core/src/signals.ts) ---------------
const MAX_SIGNALS = 50;
const CAP_SOURCE = 120;
const CAP_TITLE = 200;
const CAP_DETAIL = 2000;
const CAP_URL = 1000;
const clamp = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");
const signal = ({ source, title, detail, url, count }) => {
  const out = {
    source: clamp(source, CAP_SOURCE),
    title: clamp(title, CAP_TITLE),
    detail: clamp(detail, CAP_DETAIL),
  };
  if (typeof url === "string" && url) out.url = clamp(url, CAP_URL);
  if (Number.isFinite(count)) out.count = count;
  return out;
};
const emit = (signals) => {
  process.stdout.write(JSON.stringify(signals.slice(0, MAX_SIGNALS)));
  process.exit(0);
};
const warn = (...a) => process.stderr.write(`[hyperdx] ${a.join(" ")}\n`);

// --- arg + window parsing ---------------------------------------------------
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const durationMs = (s) => {
  const m = /^(\d+)([smhd])$/.exec(String(s).trim());
  if (!m) return 24 * 3600_000;
  const n = Number(m[1]);
  return n * { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[m[2]];
};

const APP_URL = (process.env.HYPERDX_APP_URL || "").replace(/\/+$/, "");
const ENV = process.env.HYPERDX_ENV || "";
const SINCE = argOf("--since", "24h");
const windowMs = durationMs(SINCE);
const fromMs = Date.now() - windowMs;

// --- source 1: ALWAYS-on deep search link (no credentials needed) -----------
const searchLinkSignal = () => {
  const terms = ["level:error"];
  if (ENV) terms.push(`(service:"${ENV}" OR deployment.environment:"${ENV}")`);
  const q = terms.join(" ");
  const url =
    `${APP_URL}/search?` +
    `q=${encodeURIComponent(q)}` +
    `&from=${fromMs}&to=${Date.now()}`;
  return signal({
    source: ENV ? `hyperdx:search:${ENV}` : "hyperdx:search",
    title: `HyperDX error search (last ${SINCE})`,
    detail:
      `HyperDX has no public event-search API, so this adapter cannot count` +
      ` errors. Follow the link for the live \`${q}\` search over the last` +
      ` ${SINCE} to triage what's erroring.`,
    url,
  });
};

// --- source 2: best-effort alert states (only when an API key is set) -------
const collectAlerts = async () => {
  if (!process.env.HYPERDX_API_KEY) {
    warn("alerts: HYPERDX_API_KEY unset — link-only mode");
    return [];
  }
  let res;
  try {
    res = await fetch("https://api.hyperdx.io/api/v1/alerts", {
      headers: {
        Authorization: `Bearer ${process.env.HYPERDX_API_KEY}`,
        Accept: "application/json",
      },
    });
  } catch (e) {
    warn("alerts: fetch failed —", String(e?.message ?? e));
    return [];
  }
  if (!res.ok) {
    warn(`alerts: HTTP ${res.status} — degrading to empty`);
    return [];
  }
  let body;
  try {
    body = await res.json();
  } catch (e) {
    warn("alerts: non-JSON body —", String(e?.message ?? e));
    return [];
  }
  const data = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
  if (!data) {
    warn("alerts: unexpected shape — degrading to empty");
    return [];
  }
  const isAlerting = (a) => {
    const s = String(a?.state ?? a?.status ?? "").toLowerCase();
    return s === "alert" || s === "alerting" || s === "triggered" || s === "firing";
  };
  return data.filter(isAlerting).map((a) =>
    signal({
      source: "hyperdx:alert",
      title: String(a?.name ?? a?.id ?? "HyperDX alert"),
      detail:
        `Alert in ${a?.state ?? a?.status ?? "alerting"} state.` +
        (a?.message ? ` ${String(a.message)}` : ""),
      url: a?.id ? `${APP_URL}/alerts/${a.id}` : `${APP_URL}/alerts`,
    }),
  );
};

const main = async () => {
  if (!APP_URL) {
    warn("HYPERDX_APP_URL unset — no workspace to link to, degrading to []");
    emit([]);
    return;
  }
  // The search link goes first (always present once configured); alerts follow.
  const alerts = await collectAlerts();
  emit([searchLinkSignal(), ...alerts]);
};

main().catch((e) => {
  // Last-resort guard: the contract REQUIRES exit 0 with a valid array. Emit
  // the credential-free search link if (and only if) a workspace is configured.
  warn("unexpected top-level error —", String(e?.message ?? e));
  try {
    emit(APP_URL ? [searchLinkSignal()] : []);
  } catch {
    emit([]);
  }
});
