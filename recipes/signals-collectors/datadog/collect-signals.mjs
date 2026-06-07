#!/usr/bin/env node
// signals/v1 collector — Datadog.
//
// Contract: emits a `signals/v1` array (see packages/core/src/signals.ts and
// recipes/signals-collectors/README.md). This is a CONSUMER-side reference
// adapter — the FlareDispatch Dispatcher stays vendor-blind and never queries
// Datadog. Drop this into a daily GHA job and feed its stdout to the
// `ci-triage-pr` run's `signals` input.
//
// Env vars:
//   DD_API_KEY   (required) Datadog API key.
//   DD_APP_KEY   (required) Datadog application key.
//   DD_SITE      (optional) Datadog site host, default "datadoghq.com"
//                (e.g. "datadoghq.eu", "us5.datadoghq.com").
//
// What it queries (two INDEPENDENT sources, each degrades on its own):
//   1. Events API v2 search — POST /api/v2/events/search — error-status events
//      in the window, grouped by their aggregation key into one signal each.
//   2. Monitors API v1 — GET /api/v1/monitor?group_states=alert — every monitor
//      currently in `Alert` state becomes one signal with a deep link.
//
// Window: --since <dur> (e.g. 24h, 90m, 7d), default 24h.
//
// Degradation rules (the producer contract — see README):
//   - stdout is ONLY the JSON `Signal[]`. All diagnostics go to stderr.
//   - ALWAYS exit 0 with a valid (possibly empty) array.
//   - Each source degrades to empty INDEPENDENTLY on missing env, a non-2xx
//     response, a network error, or an unexpected payload shape. A partial
//     outage still yields whatever was observable.
//   - One signal per failure CLUSTER (per monitor / per event aggregation key),
//     NOT one per raw event. Caps are clamped locally so an oversized scan
//     still decodes cleanly at the dispatch gate.
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
const warn = (...a) => process.stderr.write(`[datadog] ${a.join(" ")}\n`);

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

const SITE = process.env.DD_SITE || "datadoghq.com";
const API = `https://api.${SITE}`;
const APP = `https://app.${SITE}`;
const SINCE = argOf("--since", "24h");
const windowMs = durationMs(SINCE);
const fromMs = Date.now() - windowMs;

const ddHeaders = () => ({
  "DD-API-KEY": process.env.DD_API_KEY,
  "DD-APPLICATION-KEY": process.env.DD_APP_KEY,
  "Content-Type": "application/json",
  Accept: "application/json",
});

// --- source 1: error-status events, grouped by aggregation key --------------
const collectEvents = async () => {
  if (!process.env.DD_API_KEY || !process.env.DD_APP_KEY) {
    warn("events: DD_API_KEY / DD_APP_KEY unset — degrading to empty");
    return [];
  }
  let res;
  try {
    res = await fetch(`${API}/api/v2/events/search`, {
      method: "POST",
      headers: ddHeaders(),
      body: JSON.stringify({
        filter: {
          query: "status:error",
          from: new Date(fromMs).toISOString(),
          to: new Date().toISOString(),
        },
        page: { limit: 200 },
        sort: "-timestamp",
      }),
    });
  } catch (e) {
    warn("events: fetch failed —", String(e?.message ?? e));
    return [];
  }
  if (!res.ok) {
    warn(`events: HTTP ${res.status} — degrading to empty`);
    return [];
  }
  let body;
  try {
    body = await res.json();
  } catch (e) {
    warn("events: non-JSON body —", String(e?.message ?? e));
    return [];
  }
  const data = Array.isArray(body?.data) ? body.data : null;
  if (!data) {
    warn("events: unexpected shape (no data[]) — degrading to empty");
    return [];
  }
  // Cluster by aggregation key (falls back to the event title).
  const clusters = new Map();
  for (const ev of data) {
    const attrs = ev?.attributes?.attributes ?? ev?.attributes ?? {};
    const title = attrs?.title ?? ev?.attributes?.message ?? "Datadog error event";
    const key = attrs?.aggregation_key ?? title ?? ev?.id ?? "unknown";
    const prev = clusters.get(key);
    if (prev) {
      prev.count += 1;
    } else {
      clusters.set(key, {
        title: String(title),
        sample: String(attrs?.message ?? ev?.attributes?.message ?? ""),
        count: 1,
      });
    }
  }
  const link = `${APP}/event/explorer?query=${encodeURIComponent("status:error")}`;
  return [...clusters.values()].map((c) =>
    signal({
      source: "datadog:events",
      title: c.title,
      detail:
        `${c.count} error-status event(s) over the last ${SINCE}.` +
        (c.sample ? ` Sample: ${c.sample}` : ""),
      url: link,
      count: c.count,
    }),
  );
};

// --- source 2: monitors currently in Alert ----------------------------------
const collectMonitors = async () => {
  if (!process.env.DD_API_KEY || !process.env.DD_APP_KEY) {
    warn("monitors: DD_API_KEY / DD_APP_KEY unset — degrading to empty");
    return [];
  }
  let res;
  try {
    res = await fetch(
      `${API}/api/v1/monitor?group_states=alert&monitor_tags=*`,
      { headers: ddHeaders() },
    );
  } catch (e) {
    warn("monitors: fetch failed —", String(e?.message ?? e));
    return [];
  }
  if (!res.ok) {
    warn(`monitors: HTTP ${res.status} — degrading to empty`);
    return [];
  }
  let body;
  try {
    body = await res.json();
  } catch (e) {
    warn("monitors: non-JSON body —", String(e?.message ?? e));
    return [];
  }
  if (!Array.isArray(body)) {
    warn("monitors: unexpected shape (not an array) — degrading to empty");
    return [];
  }
  const alerting = body.filter(
    (m) => m?.overall_state === "Alert" || m?.overall_state === "Warn",
  );
  return alerting.map((m) => {
    const groups = m?.state?.groups ?? {};
    const groupCount = Object.keys(groups).length || undefined;
    return signal({
      source: "datadog:monitor",
      title: String(m?.name ?? `monitor ${m?.id}`),
      detail:
        `Monitor in ${m?.overall_state} state` +
        (groupCount ? ` across ${groupCount} group(s).` : ".") +
        (m?.message ? ` ${String(m.message)}` : ""),
      url: m?.id ? `${APP}/monitors/${m.id}` : undefined,
      count: groupCount,
    });
  });
};

// --- main: gather both, order worst-first (monitors before raw events) ------
const main = async () => {
  const [monitors, events] = await Promise.all([
    collectMonitors(),
    collectEvents(),
  ]);
  emit([...monitors, ...events]);
};

main().catch((e) => {
  // Last-resort guard: the contract REQUIRES exit 0 with a valid array.
  warn("unexpected top-level error —", String(e?.message ?? e));
  emit([]);
});
