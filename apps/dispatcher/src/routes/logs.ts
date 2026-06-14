// FlareDispatch Dispatcher — the log-viewing surfaces.
//
//   GET /v1/executions/:id/logs/:file  — one exec log (ndjson | ?format=text)
//   GET /v1/executions/:id/logs        — all exec logs, concatenated as text
//   GET /logs/:execution               — the self-contained HTML viewer
//
// All three are capability-token-gated (log-auth.ts). The full, untruncated
// log of every command already lives in R2 at `logs/<id>/exec[-N].ndjson`
// (written by SandboxCloudflareLive); these routes are the readable read side,
// replacing the truncated, JSON-escaped blob the Cloudflare Workflows instance
// explorer shows. The HTML viewer follows the routes/replay.ts precedent: one
// self-contained page from the worker's own origin, no build step, no CDN —
// and it renders attacker-controlled log bytes safely (textContent only, ANSI
// control sequences stripped, strict CSP — review M5).

import type { Env } from "../env";
import { getExecution, isTerminal } from "../executions-read";
import { gateLogAccess } from "../log-auth";
import { logKey, streamObject } from "../r2-object";

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Valid exec-log file names. Covers today's `exec.ndjson` / `exec-2.ndjson` and
 * the future step-named keys (`exec-<step>-<attempt>.ndjson`) the live-tail work
 * introduces — while refusing anything that could escape the `logs/<id>/`
 * prefix or smuggle a path segment.
 */
const LOG_FILE_RE = /^exec(-[A-Za-z0-9_]+)?\.ndjson$/;

/** Immutable once the execution is terminal; never cache a running run's logs. */
const cacheFor = (terminal: boolean): string =>
  terminal ? "private, max-age=31536000, immutable" : "no-store";

// ---------------------------------------------------------------------------
// NDJSON → text transform (streaming, never buffers the whole log)
// ---------------------------------------------------------------------------

/** One parsed NDJSON log record. */
type LogRecord = {
  readonly stream?: string;
  readonly command?: string;
  readonly line?: string;
};

/**
 * Render one NDJSON log record as a plain-text line (with trailing newline), or
 * `null` to drop it. `meta` → `$ <command>`, `stdout` → the bare line, `stderr`
 * → `[stderr] <line>`. Exported for unit tests.
 */
export const recordToText = (rec: LogRecord): string | null => {
  switch (rec.stream) {
    case "meta":
      return `$ ${rec.command ?? ""}\n`;
    case "stdout":
      return `${rec.line ?? ""}\n`;
    case "stderr":
      return `[stderr] ${rec.line ?? ""}\n`;
    default:
      return null;
  }
};

/**
 * A `TransformStream` that turns an NDJSON byte stream into plain-text bytes,
 * line-buffered so a chunk boundary mid-line is handled. Used for `?format=text`.
 */
export const makeNdjsonTextTransform = (): TransformStream<
  Uint8Array,
  Uint8Array
> => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const flushLine = (
    rawLine: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) return;
    let rec: LogRecord;
    try {
      rec = JSON.parse(trimmed) as LogRecord;
    } catch {
      // A non-JSON line (corrupt / partial flush) is surfaced verbatim rather
      // than dropped — better to show the bytes than hide them.
      controller.enqueue(encoder.encode(`${rawLine}\n`));
      return;
    }
    const text = recordToText(rec);
    if (text !== null) controller.enqueue(encoder.encode(text));
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) flushLine(line, controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) flushLine(buffer, controller);
    },
  });
};

// ---------------------------------------------------------------------------
// GET /v1/executions/:id/logs/:file
// ---------------------------------------------------------------------------

export const handleLogFile = async (
  env: Env,
  executionId: string,
  file: string,
  url: URL,
): Promise<Response> => {
  const denied = await gateLogAccess(env, executionId, url);
  if (denied !== null) return denied;

  if (!LOG_FILE_RE.test(file)) {
    return json(
      { error: "invalid_log_file", message: `not a log file name: "${file}"` },
      400,
    );
  }

  const row = await getExecution(env.RUNS_METADATA, executionId);
  const cacheControl = cacheFor(isTerminal(row?.status));
  const format = url.searchParams.get("format") ?? "ndjson";

  if (format === "text") {
    const object = await env.RUNS_STORAGE.get(logKey(executionId, file));
    if (object === null) {
      return json({ error: "log_not_found", message: file }, 404);
    }
    const body = object.body.pipeThrough(makeNdjsonTextTransform());
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": cacheControl,
        "x-content-type-options": "nosniff",
      },
    });
  }

  const res = await streamObject(env.RUNS_STORAGE, logKey(executionId, file), {
    contentType: "application/x-ndjson",
    cacheControl,
    nosniff: true,
  });
  return res ?? json({ error: "log_not_found", message: file }, 404);
};

// ---------------------------------------------------------------------------
// GET /v1/executions/:id/logs  — aggregated plain-text roll-up
// ---------------------------------------------------------------------------

export const handleLogsAggregate = async (
  env: Env,
  executionId: string,
  url: URL,
): Promise<Response> => {
  const denied = await gateLogAccess(env, executionId, url);
  if (denied !== null) return denied;

  const listed = await env.RUNS_STORAGE.list({
    prefix: `logs/${executionId}/`,
    limit: 1000,
  });
  const files = listed.objects
    .map((o) => o.key.slice(`logs/${executionId}/`.length))
    .filter((f) => LOG_FILE_RE.test(f))
    .sort(compareLogFiles);

  if (files.length === 0) {
    return json(
      { error: "no_logs", message: `no logs for execution "${executionId}"` },
      404,
    );
  }

  const row = await getExecution(env.RUNS_METADATA, executionId);
  const cacheControl = cacheFor(isTerminal(row?.status));
  const encoder = new TextEncoder();

  // Stream each file sequentially through the text transform, with a separator
  // header per file. Never buffers a whole log in memory.
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const file of files) {
        controller.enqueue(encoder.encode(`\n===== ${file} =====\n`));
        const object = await env.RUNS_STORAGE.get(logKey(executionId, file));
        if (object === null) continue;
        const reader = object.body
          .pipeThrough(makeNdjsonTextTransform())
          .getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      }
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
    },
  });
};

/** Order exec logs `exec.ndjson` < `exec-2.ndjson` < `exec-10.ndjson` < … */
const compareLogFiles = (a: string, b: string): number => {
  const n = (f: string): number => {
    const m = /^exec(?:-(\d+))?\.ndjson$/.exec(f);
    if (m === null) return Number.MAX_SAFE_INTEGER; // step-named keys sort last
    return m[1] === undefined ? 1 : Number.parseInt(m[1], 10);
  };
  const na = n(a);
  const nb = n(b);
  return na !== nb ? na - nb : a.localeCompare(b);
};

// ---------------------------------------------------------------------------
// GET /logs/:execution  — the HTML viewer
// ---------------------------------------------------------------------------

export const handleLogViewer = async (
  env: Env,
  executionId: string,
  url: URL,
): Promise<Response> => {
  const denied = await gateLogAccess(env, executionId, url);
  if (denied !== null) return denied;

  // A per-response nonce lets the inline script/style run under a strict CSP
  // while injected scripts are blocked. All log content is inserted via
  // textContent — no log bytes ever reach an HTML/script context.
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const html = viewerPage(nonce);
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "img-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join("; "),
    },
  });
};

/**
 * The viewer page. Data is NOT inlined (logs are large) — the page reads the
 * execution id + token from its own URL and fetches the JSON/NDJSON routes.
 * Everything dynamic is set via `textContent`; ANSI control bytes are stripped.
 */
const viewerPage = (nonce: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlareDispatch logs</title>
<style nonce="${nonce}">
  /* Palette mirrors the FlareDispatch docs site (flare-dispatch-docs.pages.dev),
     dark theme — Vitesse-style warm ink on near-black "paper", coral accent. */
  :root{
    color-scheme:dark;
    --paper:#0a0a0f; --paper-soft:#11121a; --surface:#13141b;
    --ink:#eae7dd; --ink-soft:#b8b6ac; --muted:#7a7d8c; --muted-soft:#51545f;
    --hairline:#23252e; --hairline-strong:#353846;
    --accent:#ff7041; --accent-soft:#2b1810;
    --wait:#8ba0cf; --wait-soft:#222a3d; --ok:#4d9375; --err:#cb7676;
    --mono:"Berkeley Mono","Iosevka Web","SF Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  html,body{margin:0;background:var(--paper);color:var(--ink);font:13px/1.5 var(--mono)}
  header{padding:10px 16px;border-bottom:1px solid var(--hairline);position:sticky;top:0;background:var(--paper);z-index:1}
  header .title{font-size:14px}
  header b{color:var(--accent)}
  .meta{color:var(--muted);font-size:12px;margin-top:4px}
  .meta a{color:var(--accent);text-decoration:none}
  .badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600}
  .badge.running,.badge.queued{background:var(--wait-soft,#222a3d);color:var(--wait)}
  .badge.success{background:#4d937522;color:var(--ok)}
  .badge.failure{background:#cb767622;color:var(--err)}
  .controls{padding:8px 16px;border-bottom:1px solid var(--hairline);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .controls input[type=search]{background:var(--surface);border:1px solid var(--hairline-strong);color:var(--ink);border-radius:6px;padding:4px 8px;min-width:220px;font-family:inherit}
  .controls label{color:var(--muted);font-size:12px;user-select:none}
  details{border-bottom:1px solid var(--hairline)}
  summary{cursor:pointer;padding:8px 16px;background:var(--paper-soft);list-style:none;position:sticky;top:96px}
  summary::-webkit-details-marker{display:none}
  summary .cmd{color:var(--accent)}
  summary .sz{color:var(--muted);font-size:11px;margin-left:8px}
  .log{padding:4px 0;overflow-x:auto}
  .ln{display:flex;white-space:pre;padding:0 16px}
  .ln:hover{background:var(--surface)}
  .ln .n{color:var(--muted-soft);text-align:right;min-width:48px;padding-right:12px;user-select:none}
  .ln.err .t{color:var(--err)}
  .empty{padding:24px 16px;color:var(--muted)}
  #status{padding:6px 16px;color:var(--muted);font-size:12px}
  .steps{display:flex;flex-wrap:wrap;gap:6px;padding:8px 16px;border-bottom:1px solid var(--hairline)}
  .step{display:inline-flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--hairline-strong);border-radius:6px;padding:3px 8px;font-size:12px}
  .step .dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}
  .step.success .dot{background:var(--ok)}
  .step.failure .dot{background:var(--err)}
  .step.running .dot{background:var(--wait)}
  .step .sd{color:var(--muted);font-size:11px}
  .summary{padding:8px 16px;border-bottom:1px solid var(--hairline)}
  .summary .verdict{font-weight:600;color:var(--ok)}
  .summary details{border:none}
  .summary summary{position:static;background:none;padding:0;top:auto;color:var(--muted);font-size:12px;cursor:pointer}
  .summary pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-word;background:var(--paper-soft);border:1px solid var(--hairline);border-radius:6px;padding:8px;max-height:240px;overflow:auto;font-size:12px}
  .arts{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--hairline)}
  .arts .lbl{color:var(--muted);font-size:12px}
  .art{display:inline-block;background:var(--surface);border:1px solid var(--hairline-strong);border-radius:6px;padding:3px 8px;font-size:12px;color:var(--accent);text-decoration:none}
  .art:hover{border-color:var(--accent)}
</style></head>
<body>
<header>
  <div class="title"><b>FlareDispatch</b> logs · <span id="run"></span></div>
  <div class="meta" id="sub"></div>
</header>
<div id="summary" class="summary" hidden></div>
<div id="artifacts" class="arts" hidden></div>
<div id="steps" class="steps" hidden></div>
<div class="controls">
  <input type="search" id="filter" placeholder="filter lines…" autocomplete="off">
  <label><input type="checkbox" id="stderrOnly"> stderr only</label>
  <span id="status"></span>
</div>
<div id="sections"><div class="empty">Loading…</div></div>
<script nonce="${nonce}">
"use strict";
(function(){
  var parts = location.pathname.split("/").filter(Boolean); // ["logs", id]
  var id = decodeURIComponent(parts[parts.length - 1] || "");
  var t = new URLSearchParams(location.search).get("t") || "";
  var qs = "?t=" + encodeURIComponent(t);
  var API = "/v1/executions/" + encodeURIComponent(id);
  var sectionsEl = document.getElementById("sections");
  var statusEl = document.getElementById("status");
  var files = {}; // file -> { section, body, lines:[{text,err}], finalized }

  // Strip ANSI/control sequences; render is ALWAYS via textContent so log
  // bytes can never become markup (the viewer renders attacker-controlled
  // output — see the route's CSP + this defence).
  function clean(s){
    return String(s == null ? "" : s)
      .replace(/\\u001b\\[[0-9;?]*[ -\\/]*[@-~]/g, "")
      .replace(/[\\u0000-\\u0008\\u000b-\\u001f]/g, "");
  }
  function badge(st){
    var b = document.createElement("span");
    b.className = "badge " + (st || "");
    b.textContent = st || "?";
    return b;
  }
  function setHeader(ex){
    document.getElementById("run").textContent =
      ex.run + " · " + ex.repo + "@" + (ex.sha||"").slice(0,12);
    var sub = document.getElementById("sub");
    sub.textContent = "";
    sub.appendChild(badge(ex.status));
    var dur = (ex.completedAt && ex.startedAt)
      ? " · " + Math.round((ex.completedAt-ex.startedAt)/1000) + "s" : "";
    sub.appendChild(document.createTextNode(" " + ex.id + dur + " "));
    if (ex.dashboardUrl){
      var a=document.createElement("a");
      a.href=ex.dashboardUrl; a.textContent="Cloudflare ↗"; a.rel="noreferrer";
      sub.appendChild(a);
    }
  }
  // Render the D1 step timeline — a run's shape even when it has sparse exec
  // logs (e.g. a mostly-Worker-side run like pr-review: one container exec,
  // the rest model/GitHub calls). Each chip = step name + status dot + duration.
  function fmtMs(ms){ return ms >= 1000 ? Math.round(ms/1000) + "s" : ms + "ms"; }
  function renderSteps(steps){
    var el = document.getElementById("steps");
    if (!steps || !steps.length){ el.hidden = true; return; }
    el.hidden = false; el.textContent = "";
    steps.forEach(function(s){
      var chip = document.createElement("span"); chip.className = "step " + (s.status||"");
      var dot = document.createElement("span"); dot.className = "dot";
      var nm = document.createElement("span"); nm.textContent = s.name;
      chip.appendChild(dot); chip.appendChild(nm);
      if (s.completedAt && s.startedAt){
        var sd = document.createElement("span"); sd.className = "sd";
        sd.textContent = fmtMs(s.completedAt - s.startedAt);
        chip.appendChild(sd);
      }
      el.appendChild(chip);
    });
  }
  // Render the run's own terminal output (run-agnostic): a verdict badge when
  // present, plus a collapsible pretty-printed JSON. Always via textContent.
  function renderSummary(summary){
    var el = document.getElementById("summary");
    if (summary == null || typeof summary !== "object"){ el.hidden = true; return; }
    el.hidden = false; el.textContent = "";
    if (typeof summary.verdict === "string"){
      var v = document.createElement("span"); v.className = "verdict";
      v.textContent = "verdict: " + clean(summary.verdict);
      el.appendChild(v); el.appendChild(document.createTextNode("  "));
    }
    var det = document.createElement("details");
    var sm = document.createElement("summary"); sm.textContent = "run summary (JSON)";
    var pre = document.createElement("pre");
    try { pre.textContent = JSON.stringify(summary, null, 2); }
    catch(e){ pre.textContent = String(summary); }
    det.appendChild(sm); det.appendChild(pre); el.appendChild(det);
  }
  // Render the run's PRODUCED FILES — what it explicitly uploaded as artifacts
  // to R2 (a report, a video, the captured diff). These are the right surface
  // for "files the run wrote": persisted by opt-in, served (and browsable) at
  // /v1/artifacts/:id/:name. Container scratch files are NOT here by design —
  // the container is destroyed at run end.
  function renderArtifacts(arts){
    var el = document.getElementById("artifacts");
    if (!arts || !arts.length){ el.hidden = true; return; }
    el.hidden = false; el.textContent = "";
    var lbl = document.createElement("span"); lbl.className = "lbl"; lbl.textContent = "artifacts:";
    el.appendChild(lbl);
    arts.forEach(function(a){
      var link = document.createElement("a"); link.className = "art";
      link.href = a.url; link.rel = "noreferrer"; link.textContent = a.name;
      el.appendChild(link);
    });
  }
  function applyFilter(){
    var q = document.getElementById("filter").value.toLowerCase();
    var errOnly = document.getElementById("stderrOnly").checked;
    for (var f in files){
      var rec = files[f];
      var els = rec.body.querySelectorAll(".ln");
      for (var i=0;i<rec.lines.length;i++){
        var ll = rec.lines[i];
        var show = (!errOnly || ll.err) && (q==="" || ll.text.toLowerCase().indexOf(q)>=0);
        if (els[i]) els[i].style.display = show ? "" : "none";
      }
    }
  }
  function renderInto(rec, ndjson){
    var logEl = document.createElement("div"); logEl.className = "log";
    var lines = [];
    var rows = ndjson.split("\\n");
    var num = 0;
    for (var i=0;i<rows.length;i++){
      var raw = rows[i].trim(); if (!raw) continue;
      var parsed; try { parsed = JSON.parse(raw); } catch(e){ parsed = { stream:"stdout", line: rows[i] }; }
      var text, err=false;
      if (parsed.stream==="meta") text = "$ " + clean(parsed.command);
      else if (parsed.stream==="stderr"){ text = clean(parsed.line); err=true; }
      else if (parsed.stream==="stdout") text = clean(parsed.line);
      else continue;
      num++;
      var ln = document.createElement("div"); ln.className = "ln" + (err?" err":"");
      var n = document.createElement("span"); n.className="n"; n.textContent = String(num);
      var tt = document.createElement("span"); tt.className="t"; tt.textContent = text;
      ln.appendChild(n); ln.appendChild(tt); logEl.appendChild(ln);
      lines.push({ text: text, err: err });
    }
    rec.body.innerHTML = "";
    if (lines.length===0){
      var e=document.createElement("div"); e.className="empty"; e.textContent="(no output)";
      rec.body.appendChild(e);
    } else rec.body.appendChild(logEl);
    rec.lines = lines;
  }
  function ensureSection(l, openLast){
    var rec = files[l.file];
    if (rec) return rec;
    var det = document.createElement("details");
    det.id = l.file;
    if (openLast) det.open = true;
    var sum = document.createElement("summary");
    var cmd = document.createElement("span"); cmd.className="cmd"; cmd.textContent = l.file;
    var sz = document.createElement("span"); sz.className="sz"; sz.textContent = (l.size/1024).toFixed(1)+" KB";
    sum.appendChild(cmd); sum.appendChild(sz);
    var body = document.createElement("div");
    det.appendChild(sum); det.appendChild(body);
    sectionsEl.appendChild(det);
    rec = files[l.file] = { section: det, body: body, lines: [], finalized: false };
    return rec;
  }
  function fetchLog(file, rec){
    return fetch(API + "/logs/" + encodeURIComponent(file) + qs)
      .then(function(r){ return r.ok ? r.text() : ""; })
      .then(function(txt){ renderInto(rec, txt); applyFilter(); });
  }
  function syncSections(detail, terminal){
    var logs = detail.logs || [];
    if (logs.length===0 && Object.keys(files).length===0){
      sectionsEl.innerHTML = '<div class="empty">No logs yet for this execution.</div>';
      return Promise.resolve();
    }
    var empty = sectionsEl.querySelector(".empty");
    if (empty) empty.remove();
    var jobs = [];
    logs.forEach(function(l, idx){
      var rec = ensureSection(l, idx === logs.length-1);
      // Re-fetch only files not yet finalized (the last/growing one while live).
      if (!rec.finalized){
        if (terminal) rec.finalized = true;
        jobs.push(fetchLog(l.file, rec));
      }
    });
    return Promise.all(jobs);
  }
  function tick(){
    fetch(API + qs).then(function(r){
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function(detail){
      setHeader(detail.execution);
      renderSteps(detail.steps);
      renderSummary(detail.summary);
      renderArtifacts(detail.artifacts);
      var st = detail.execution.status;
      var terminal = (st !== "running" && st !== "queued");
      return syncSections(detail, terminal).then(function(){
        if (terminal){
          statusEl.textContent = "done";
          if (location.hash){ var el=document.getElementById(location.hash.slice(1)); if(el) el.scrollIntoView(); }
        } else {
          statusEl.textContent = "● live — refreshing…";
          setTimeout(tick, 5000);
        }
      });
    }).catch(function(e){
      statusEl.textContent = "error: " + e.message;
    });
  }
  document.getElementById("filter").addEventListener("input", applyFilter);
  document.getElementById("stderrOnly").addEventListener("change", applyFilter);
  // Validate the deep-link fragment before any DOM lookup uses it.
  if (location.hash && !/^#exec(-[A-Za-z0-9_]+)?\\.ndjson$/.test(location.hash)){
    location.hash = "";
  }
  tick();
})();
</script>
</body></html>`;
