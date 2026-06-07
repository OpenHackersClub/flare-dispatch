#!/usr/bin/env node
// signals/v1 collector — SigNoz (self-hosted or cloud).
//
// Contract: emits a `signals/v1` array (see packages/core/src/signals.ts and
// recipes/signals-collectors/README.md). This is a CONSUMER-side reference
// adapter — the FlareDispatch Dispatcher stays vendor-blind and never queries
// SigNoz. Drop this into a daily GHA job and feed its stdout to the
// `ci-triage-pr` run's `signals` input.
//
// Env vars:
//   SIGNOZ_API_URL  (optional) base URL, default "http://localhost:3301".
//   SIGNOZ_API_KEY  (optional) sent as the `SIGNOZ-API-KEY` header when set
//                   (required by SigNoz Cloud; self-hosted may not need it).
//
// What it queries:
//   GET {SIGNOZ_API_URL}/api/v1/rules — the alert rules and their state. Every
//   rule whose state is `firing` becomes one signal (rule name + description).
//
// Window: --since <dur> is accepted for symmetry with the other adapters and
// echoed into the detail line; SigNoz reports current rule state, so the
// window does not filter the rules query itself.
//
// Degradation rules (the producer contract — see README):
//   - stdout is ONLY the JSON `Signal[]`. All diagnostics go to stderr.
//   - ALWAYS exit 0 with a valid (possibly empty) array.
//   - Degrades to empty on a network error, a non-2xx response, or an
//     unexpected payload shape.
//   - One signal per FIRING rule (a cluster), not per underlying sample. Caps
//     are clamped locally so an oversized scan still decodes at the gate.
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
const warn = (...a) => process.stderr.write(`[signoz] ${a.join(" ")}\n`);

// --- arg parsing ------------------------------------------------------------
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SINCE = argOf("--since", "24h");

const BASE = (process.env.SIGNOZ_API_URL || "http://localhost:3301").replace(
  /\/+$/,
  "",
);

const sigHeaders = () => {
  const h = { Accept: "application/json" };
  if (process.env.SIGNOZ_API_KEY) h["SIGNOZ-API-KEY"] = process.env.SIGNOZ_API_KEY;
  return h;
};

// SigNoz `/api/v1/rules` shapes have shifted across versions. Be permissive:
// accept either `{ data: { rules: [...] } }`, `{ data: [...] }`, or `[...]`.
const extractRules = (body) => {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.data?.rules)) return body.data.rules;
  if (Array.isArray(body?.rules)) return body.rules;
  return null;
};

// A rule's state lives under different keys across versions; firing ~= "firing".
const ruleState = (r) =>
  String(r?.state ?? r?.status ?? r?.alertState ?? "").toLowerCase();
const isFiring = (r) => ruleState(r) === "firing" || ruleState(r) === "alerting";

const collectRules = async () => {
  let res;
  try {
    res = await fetch(`${BASE}/api/v1/rules`, { headers: sigHeaders() });
  } catch (e) {
    warn("rules: fetch failed —", String(e?.message ?? e));
    return [];
  }
  if (!res.ok) {
    warn(`rules: HTTP ${res.status} — degrading to empty`);
    return [];
  }
  let body;
  try {
    body = await res.json();
  } catch (e) {
    warn("rules: non-JSON body —", String(e?.message ?? e));
    return [];
  }
  const rules = extractRules(body);
  if (!rules) {
    warn("rules: unexpected shape (no rules[]) — degrading to empty");
    return [];
  }
  const firing = rules.filter(isFiring);
  return firing.map((r) => {
    const id = r?.id ?? r?.alert ?? r?.ruleId;
    const name = r?.alert ?? r?.alertName ?? r?.name ?? `rule ${id}`;
    const desc =
      r?.annotations?.description ??
      r?.labels?.description ??
      r?.description ??
      "";
    const sev = r?.labels?.severity ?? r?.severity;
    return signal({
      source: "signoz:rule",
      title: String(name),
      detail:
        `Alert rule firing${sev ? ` (severity: ${sev})` : ""}.` +
        ` Observed over the last ${SINCE}.` +
        (desc ? ` ${String(desc)}` : ""),
      url: id ? `${BASE}/alerts/edit?ruleId=${encodeURIComponent(id)}` : `${BASE}/alerts`,
    });
  });
};

const main = async () => {
  const rules = await collectRules();
  emit(rules);
};

main().catch((e) => {
  // Last-resort guard: the contract REQUIRES exit 0 with a valid array.
  warn("unexpected top-level error —", String(e?.message ?? e));
  emit([]);
});
