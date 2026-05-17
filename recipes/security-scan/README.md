# Recipe: security / dependency scan

Run dependency and vulnerability scanners against a checked-out repo — on every PR and on a weekly schedule, so newly-disclosed CVEs are caught even in code that hasn't changed. Each scanner runs in its own CF container, in parallel.

## Files

- [`security-scan.run.ts`](security-scan.run.ts) — the typed Run: fan out the selected scanners, run each in its own container, upload a report per scanner, fail if any scanner trips its threshold.
- [`ci.yml`](ci.yml) — the GitHub Actions workflow that dispatches the run (Action mode), on `pull_request` and a weekly `schedule`.

## How it works

`ci.yml` dispatches `security-scan` with a list of `scanners` (`pnpm-audit`, `trivy-fs`, `gitleaks`, …) and a `failOn` severity. Each scanner exits non-zero at or above that severity; the run's check-run, `flaredispatch/security-scan`, is red if any scanner trips. The scheduled run uses the default branch's SHA — same run slug, no extra wiring.

## Install

1. Deploy FlareDispatch and install the GitHub App — see [specs/05-byoc.md](../../specs/05-byoc.md).
2. Add `security-scan.run.ts` to your repo's `runs/` directory.
3. Copy `ci.yml` into `.github/workflows/`; adjust the `scanners` list and `failOn`.
4. In branch protection, require the `flaredispatch/security-scan` check-run.
