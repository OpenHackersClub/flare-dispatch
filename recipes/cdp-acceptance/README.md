# Recipe: CDP acceptance tests

Boot the app under test in a CF container, attach Cloudflare Browser Rendering over the Chrome DevTools Protocol, and run an acceptance suite that asserts on real browser behaviour — network calls, console errors, document counts, heap deltas.

## Files

- [`cdp-acceptance.run.ts`](cdp-acceptance.run.ts) — the typed Run: checkout → install → boot the app detached → wait for its port → attach CDP → run the suite → upload the report and a screenshots/trace bundle.
- [`ci.yml`](ci.yml) — the GitHub Actions workflow that dispatches the run (Action mode, **await** — so a follow-up deploy job can `needs:` it).

## How it works

On `pull_request`, `ci.yml` dispatches `cdp-acceptance`. The run boots the app, drives it over CDP, and reports the `flaredispatch/cdp-acceptance` check-run. Because the workflow uses `mode: await`, the GHA step mirrors the run's conclusion — a deploy gate downstream can depend on it.

## Screenshots & demo on the PR

The run uploads two artifacts, each surfaced as a signed R2 URL in the check-run summary:

- **`acceptance-report`** — the HTML acceptance report.
- **`screenshots`** — the screenshots and the Playwright trace captured during the run.

A reviewer can open those URLs straight from the PR's Checks tab. The screenshots — and the trace played back as a short demo recording — can be **dragged directly into the PR description or a review comment**, so reviewers get visual evidence of the change without checking anything out locally.

## Install

1. Deploy FlareDispatch and install the GitHub App — see [specs/05-byoc.md](../../specs/05-byoc.md).
2. Add `cdp-acceptance.run.ts` to your repo's `runs/` directory.
3. Copy `ci.yml` into `.github/workflows/`; adjust `appBootCommand`, `appPort`, `testCommand`.
4. Have the acceptance suite write screenshots/traces under `./artifacts` so the `screenshots` upload picks them up.
