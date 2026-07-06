# 10 — `demo-bundle/v1`: the demo capture bundle

> **Status: Live at HEAD** (producer). Source: `buildDemoBundleManifest` + the
> `archive-frames` / `upload-frames-archive` / `upload-manifest.json` steps in
> [`runs/product-demo.ts`](../runs/product-demo.ts).
> Consumers: [autopresenter](https://github.com/OpenHackersClub/autopresenter)
> `import demo` (external), the `demo-reel` child run (this repo).

`demo-bundle/v1` is the narrow-waist contract between FlareDispatch's demo
**capture** (product-demo: rrweb + per-action frames + screenshots + GIFs) and
any downstream **presentation** consumer (deck/video renderers, reels,
release-notes media). It plays the same role for demo footage that
[`signals/v1`](08-self-healing.md) plays for failures: a small, versioned,
vendor-blind JSON document that lets the two sides evolve independently.

## Design rules

1. **Files, not APIs.** A bundle is `manifest.json` plus sibling files. No
   consumer authenticates against the dispatcher; the manifest and its
   siblings are served by the deliberately-public artifact route
   (`GET /v1/artifacts/:execution/:name`, [01-architecture.md](01-architecture.md))
   — or simply sit together in a local directory. Copying the files *is*
   relocating the bundle.
2. **Relative names only.** Every reference inside the manifest is a bare
   artifact name (`chapter-0.gif`, `frames.tar`), resolved against the
   manifest's own location. No absolute URLs, no R2 keys, no host coupling.
3. **Present ⇒ resolvable.** Optional entries appear only when the
   corresponding upload actually landed. A consumer never probes; it trusts
   the manifest.
4. **Pixels are the footage; rrweb is the replay.** The rrweb event JSON is
   DOM events, not pixels — rendering video from it would require a browser
   replay. Consumers that produce video read `frames.tar` (full-resolution
   PNGs) or fall back to the per-chapter GIFs / key screenshots. `replayJson`
   stays in the bundle for interactive scrubbing and debugging.

## Bundle layout

All names live under one execution's artifact space
(`artifacts/<exec>/…` in R2, `/v1/artifacts/<exec>/…` over HTTP):

| Name | Type | Always? | Notes |
| --- | --- | --- | --- |
| `manifest.json` | `demo-bundle/v1` | ✅ | The index — fetch this first |
| `summary.md` | markdown | ✅ | Human-readable per-chapter table |
| `frames.tar` | tar of PNGs | when frames captured | `<story>-NNNN.png`, full resolution, walkthrough-ordered |
| `demo.gif` | GIF | when encoded | Combined walkthrough (≤ 800 px, camo-budgeted) |
| `chapter-<i>.gif` | GIF | per chapter, when encoded | One story's own frames |
| `<story>.png` | PNG | per chapter, when captured | The key screenshot |
| `replay-<i>.json` | rrweb events | per chapter, when recorded | Flattened, timestamp-sorted |
| `stories.json` / `signals.json` | JSON | ✅ | Structured results / `signals/v1` (pre-existing, not manifest-indexed) |

## Manifest schema

```jsonc
{
  "kind": "demo-bundle/v1",
  "repo": "owner/app",
  "sha": "…",                      // the commit the demo ran against
  "target": "https://…",           // the deployed URL the demo drove
  "summary": "summary.md",
  "gif": "demo.gif",               // optional
  "framesArchive": "frames.tar",   // optional
  "stories": [
    {
      "name": "checkout",
      "prose": "Buy an item…",     // operator-authored — the narration source
      "status": "passed" | "failed",
      "failureKind": "assertion" | "infra" | "timeout" | "unparseable", // failed only
      "narrative": "…",            // LLM-written — UNTRUSTED, display only
      "durationMs": 0, "chapterStartMs": 0, "chapterEndMs": 0,
      "framesPrefix": "checkout-", // selects this chapter inside framesArchive
      "keyScreenshot": "checkout.png",   // optional
      "gif": "chapter-0.gif",            // optional
      "replayJson": "replay-0.json"      // optional
    }
  ]
}
```

The authoritative TypeScript shape is the exported `DemoBundleManifest` in
[`runs/product-demo.ts`](../runs/product-demo.ts) — this page documents intent,
the type is the contract.

## Trust posture

- `prose` is operator-authored (the story script) — trusted like any run input.
- `narrative` is an LLM summary of a live, possibly attacker-influenced page —
  **untrusted**. Consumers render it as text; never execute, never feed to a
  tool-calling loop unfenced (same posture as
  [08-self-healing.md § signal fencing](08-self-healing.md)).
- Artifacts are public on deploys with the public artifact route — a bundle
  must never contain secrets. Frames/screenshots are whatever the browser
  showed; a demo against a page displaying secrets publishes them. That is
  already true of the GIF/PR-comment path; the bundle adds no new exposure.

## Versioning

`kind` is the version gate. Additive fields land in `v1`; anything that
changes the meaning of an existing field mints `demo-bundle/v2` and producers
dual-publish during migration (same policy as `signals/v1`).

## Consumers

- **`demo-reel`** (this repo, [`runs/demo-reel.ts`](../runs/demo-reel.ts)):
  child run spawned after a product-demo execution when
  `demo-reel.enabled=true`; fetches the bundle over the artifact route,
  renders a deck (always) + narrated MP4 (tool-gated) via autopresenter in
  the sandbox. Operator guide: [recipes/demo-reel/](../recipes/demo-reel/README.md).
- **autopresenter `import demo <dir|url>`** (external): lowers a bundle into a
  SceneGraph composition — one story per scene, `prose` as narration, frames /
  chapter GIF / key screenshot as the scene's footage.
