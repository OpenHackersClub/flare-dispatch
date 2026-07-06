# demo-reel — turn a captured product demo into a deck + narrated MP4

`demo-reel` is the **presentation stage** for [`product-demo`](../product-demo/):
it consumes the [`demo-bundle/v1`](../../specs/10-demo-bundle.md) a demo
execution publishes (raw frames, per-chapter GIFs, screenshots, story prose)
and renders it through
[autopresenter](https://github.com/OpenHackersClub/autopresenter) into:

- **`demo-deck.html`** — a self-contained slide deck, always (pure Node).
- **`demo-reel.mp4`** — a narrated video reel, when the sandbox image carries
  `ffmpeg` + `rsvg-convert` (see [`Dockerfile.example`](Dockerfile.example)).

The division of labour: FlareDispatch owns **capture** (browser, rrweb,
frames), autopresenter owns **presentation** (SceneGraph composition, TTS
narration, deck/video projection). The only coupling is the bundle contract
and autopresenter's CLI — no shared libraries.

## Enable it

1. *(optional, for MP4)* Add the [`Dockerfile.example`](Dockerfile.example)
   layer to your `Dockerfile.sandbox` and redeploy.
2. Opt in via CONFIG_KV:

   ```sh
   wrangler kv key put --binding CONFIG_KV "demo-reel.enabled" "true"
   # optional: pin autopresenter for reproducible reels (default: main)
   wrangler kv key put --binding CONFIG_KV "demo-reel.autopresenter-ref" "<sha-or-tag>"
   ```

3. That's it — every `product-demo` completion now spawns a `demo-reel`
   child (deduped per bundle, best-effort: a reel failure never flips the
   demo verdict). When the demo dispatch carried a `pr`, the reel posts its
   own PR comment linking the deck (and reel, when rendered).

## Direct dispatch

Any hosted `demo-bundle/v1` works — not just a fresh execution's:

```sh
curl -X POST "$FLAREDISPATCH_URL/v1/dispatch/demo-reel" \
  -H "content-type: application/json" \
  -H "x-signature: $HMAC" \
  -d '{
    "repo": "owner/app", "sha": "<sha>",
    "bundleUrl": "/v1/artifacts/<execution>/manifest.json",
    "pr": 123
  }'
```

`bundleUrl` may be relative (resolved against `product-demo.docsBase`) or an
absolute URL to any reachable manifest.

## Local usage (no FlareDispatch at all)

The bundle is just files — the same rendering works on a laptop:

```sh
# grab a bundle (or point at a local artifacts dir)
autopresenter import demo https://<dispatcher>/v1/artifacts/<exec>/manifest.json -o reel
# tweak reel/deck.md — reorder scenes, tighten narration — then:
autopresenter render reel/deck.md --target slides -o dist/deck
autopresenter render reel/deck.md --target video  -o dist/demo-reel.mp4
```

## Knobs

| CONFIG_KV key | Default | Meaning |
| --- | --- | --- |
| `demo-reel.enabled` | *(unset — off)* | Spawn the child after each product-demo |
| `demo-reel.autopresenter-ref` | `main` | Branch/tag/sha of autopresenter to render with |
| `product-demo.docsBase` | dispatcher origin | Absolutizes relative bundle/artifact URLs |
| `product-demo.secret/CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | *(shared with product-demo)* | TTS narration via Workers AI (optional) |
