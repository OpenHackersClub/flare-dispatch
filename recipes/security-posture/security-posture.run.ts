// Recipe: scheduled BYOC security-posture review → draft PR
//
// A custom, recipe-only Run (not a deployed `runs/` mirror). Drop it into your
// repo's `runs/` directory; the Dispatcher auto-discovers it. See ./README.md.
//
// A Schedule-mode run that, every week, audits the security posture of YOUR
// FlareDispatch BYOC deployment itself — not a checked-out repo's dependencies
// (that's `security-scan`), but the Dispatcher's own trust surface: are the API
// tokens least-privilege, is defense-in-depth actually wired, are the long-lived
// secrets the ones you still need? It scores the deployment against the canonical
// trust model (specs/07-trust-model.md) and opens ONE draft pull request carrying
// a posture scorecard + findings (`.flare-dispatch/security-posture-<date>.md`).
// It proposes nothing automatically — every finding is a recommendation a human
// reviews; a security audit that silently mutates its own controls would be the
// bug, not the feature.
//
// --- What it can read, and what you must declare -----------------------------
//
// A Run executes inside a Workflow; it CANNOT introspect which Worker Secrets or
// bindings are set (`io.env` is a deliberate no-op — Worker Env is a deploy-time
// fact, and "the operator's Cloudflare account is sound" is an explicit trust
// assumption, specs/07-trust-model.md § Scope and non-goals). So the audit has
// two input planes:
//
//   • LIVE (introspected)   — the GitHub App's real install blast-radius, via
//                             `github.repositories()`: how many repos / distinct
//                             installations the App's key actually reaches. This
//                             is the one least-privilege signal the Run can
//                             measure directly, and the highest-value one.
//   • DECLARED (CONFIG_KV)  — a small posture manifest you keep current under
//                             `security-posture.manifest` (a JSON value): the CF
//                             API-token scopes, the App permission set, which
//                             defense-in-depth controls are on. The audit holds
//                             these against a least-privilege / defense-in-depth
//                             rubric every week and flags drift.
//
// Deterministic rules produce the high-confidence findings (over-broad token,
// missing DiD layer, an unneeded long-lived secret) with no model in the loop.
// The model pass adds the narrative scorecard and catches what the rules miss —
// and if the model is unconfigured or errors, the audit STILL files the
// rules-only report rather than going dark (a security control should fail open
// to "tell me less", never to "tell me nothing").
//
// --- CONFIG the operator sets (out of band) ---------------------------------
//
//   CONFIG_KV  security-posture.manifest       JSON posture manifest (see PostureManifest below) — the declared plane
//   CONFIG_KV  security-posture.report-repo    repo to open the audit PR on (required) — usually your flare-dispatch fork
//   CONFIG_KV  security-posture.base           base branch for the audit PR (default "main")
//   CONFIG_KV  security-posture.min-severity   only open a PR when a finding is at/above this (default "info" — always)
//   CONFIG_KV  security-posture.backend         "workers-ai" | "anthropic" | "bedrock"  (default workers-ai) — the narrative model
//   CONFIG_KV  security-posture.prompt          (optional) override the auditor system prompt
//   CONFIG_KV  security-posture.workers-ai.model  model id — catalog id or `deepseek/` reasoner (+ .workers-ai.mode "tools"|"json", default "tools")
//
// Mode: Schedule mode — specs/04-gha-integration.md § Schedule mode. The cron
// MUST also be in wrangler.jsonc `triggers.crons`.

import { Effect, Option, Schema } from "effect";
import {
  config,
  defineRun,
  github,
  io,
  StepFailed,
  step,
  type RepoRef,
} from "@flare-dispatch/core";
import { isoDate } from "@flare-dispatch/core/primitives";
import {
  completeStructured,
  namespacedKey,
  promptKey,
  resolveBackend,
} from "@flare-dispatch/review-agent";

const NAMESPACE = "security-posture";
const key = namespacedKey(NAMESPACE);
const MANIFEST_KEY = key("manifest");
const REPORT_REPO_KEY = key("report-repo");
const BASE_KEY = key("base");
const MIN_SEVERITY_KEY = key("min-severity");

const REVIEW_MAX_TOKENS = 3072;

// --- The shared finding shape ------------------------------------------------

const Severity = Schema.Literal("info", "low", "medium", "high", "critical");
type SeverityT = typeof Severity.Type;

/** Ascending severity — index = how loud. Used for the min-severity gate + sort. */
const SEVERITY_ORDER: readonly SeverityT[] = ["info", "low", "medium", "high", "critical"];
const rank = (s: SeverityT): number => SEVERITY_ORDER.indexOf(s);

/** Coerce a CONFIG_KV `min-severity` string into a SeverityT; default "info" (always open). */
const normalizeSeverity = (raw: string | undefined): SeverityT => {
  const v = (raw ?? "").trim().toLowerCase();
  return SEVERITY_ORDER.find((s) => s === v) ?? "info";
};

const Principle = Schema.Literal(
  "least-privilege",
  "defense-in-depth",
  "secret-hygiene",
  "blast-radius",
  "platform-residual",
);

const Status = Schema.Literal("ok", "gap", "unknown");

/** One posture observation — emitted both by the deterministic rules and the model. */
const Finding = Schema.Struct({
  /** The control under review, e.g. "CLOUDFLARE_API_TOKEN scope". */
  control: Schema.String,
  principle: Principle,
  severity: Severity,
  /** "ok" (verified sound) | "gap" (action needed) | "unknown" (can't tell from inputs). */
  status: Status,
  /** What was observed, in one or two sentences. */
  finding: Schema.String,
  /** The concrete next step (empty for a clean "ok"). */
  recommendation: Schema.String,
  /** Optional pointer into specs/07-trust-model.md. */
  reference: Schema.optional(Schema.String),
});
type FindingT = typeof Finding.Type;

const PostureReview = Schema.Struct({
  /** A 2–3 sentence overall read of the deployment's posture. */
  summary: Schema.String,
  findings: Schema.Array(Finding),
});

// --- The operator-declared posture manifest ----------------------------------

const SetState = Schema.Literal("set", "unset", "n/a");

/**
 * What the operator asserts about their deployment — the plane the Run can't
 * introspect. Every field defaults to the most-unknown value so a partially-
 * filled manifest still audits cleanly (missing field → surfaced as "unknown",
 * never a false "ok").
 */
const PostureManifest = Schema.Struct({
  /** The Dispatcher's public origin (report context only). */
  endpoint: Schema.optionalWith(Schema.String, { default: () => "" }),
  /** Which trigger paths are actually in use — decides which secrets are *required*. */
  triggerModes: Schema.optionalWith(
    Schema.Array(Schema.Literal("action", "webhook", "schedule")),
    { default: () => [] },
  ),

  // Defense-in-depth toggles.
  /** Is the Worker fronted by a custom domain? (Cloudflare Access can't front *.workers.dev.) */
  customDomain: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /** VIEWER_ACCESS_MODE posture for the log/demo/replay viewer surfaces. */
  viewerAccess: Schema.optionalWith(
    Schema.Literal("required", "token-only", "unset"),
    { default: () => "unset" as const },
  ),
  /** Is ADMIN_TOKEN set? "n/a" when no run uses step.waitForEvent. */
  adminToken: Schema.optionalWith(SetState, { default: () => "n/a" as const }),
  /** Is Cloudflare Access in front of /v1/admin/* (defense-in-depth over the bearer gate)? */
  adminAccessFronted: Schema.optionalWith(Schema.Boolean, { default: () => false }),

  // Secret presence (the Run can't read these — declare them).
  hmacSecret: Schema.optionalWith(SetState, { default: () => "unset" as const }),
  webhookSecret: Schema.optionalWith(SetState, { default: () => "unset" as const }),
  /** BROWSER_CDP_API_TOKEN — long-lived static credential (known gap). "n/a" if no CDP run. */
  browserCdpToken: Schema.optionalWith(SetState, { default: () => "n/a" as const }),
  /** Does any run federate to AWS/GCP/Vault via the `oidc` capability? */
  oidcFederation: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /** Declared secret-rotation cadence in days (0/absent → none declared). */
  secretRotationDays: Schema.optionalWith(Schema.Number, { default: () => 0 }),

  // Least-privilege of the API credentials.
  /** The CLOUDFLARE_API_TOKEN's granted scopes, as named on the CF token page. */
  cloudflareApiTokenScopes: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
  /** What the CF token is *for* (e.g. "deploy", "ci-triage read"). Drives read-vs-write checks. */
  cloudflareApiTokenPurpose: Schema.optionalWith(Schema.String, { default: () => "" }),
  /** The GitHub App's configured permission set, e.g. {"checks":"write","contents":"read"}. */
  githubAppPermissions: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.String }),
    { default: () => ({}) },
  ),
  /** "selected" (specific repos) | "all" (every repo in the org) | "unknown". */
  githubAppInstallScope: Schema.optionalWith(
    Schema.Literal("selected", "all", "unknown"),
    { default: () => "unknown" as const },
  ),
});
type PostureManifestT = typeof PostureManifest.Type;

const Input = Schema.Struct({ firedAt: Schema.Number });

const Output = Schema.Struct({
  findings: Schema.Number,
  highestSeverity: Schema.String,
  modelNarrative: Schema.Boolean,
  prOpened: Schema.Boolean,
  prUpdated: Schema.Boolean,
  prNumber: Schema.Number,
});

const DEFAULT_AUDITOR_PROMPT = `You are a cloud security auditor reviewing a BYOC "FlareDispatch" deployment —
a single Cloudflare Worker (the Dispatcher) that offloads CI work into Workflows
and Containers, holds a GitHub App private key, an HMAC secret, and scoped API
tokens. Two security principles govern the review: LEAST PRIVILEGE (every token,
secret, and permission should grant the minimum the deployment uses — nothing
broader) and DEFENSE IN DEPTH (no single control is the only thing standing
between an adversary and the crown jewels).

You are given (1) the live GitHub App install blast-radius, (2) the operator's
declared posture manifest, and (3) the deterministic findings already raised by
rule checks. Add findings the rules did not — and only where the inputs support
them. For each: name the control, the principle it touches, a severity, whether
it is ok / a gap / unknown, what you observed, and a concrete next step. Do NOT
invent facts not present in the inputs; when a field is unknown, say so as an
"unknown" finding rather than guessing. Prefer a few high-signal findings over
many shallow ones. End with a 2–3 sentence overall posture summary. This is an
advisory write-up for a human operator, not an automated remediation.`;

export const securityPosturePr = defineRun({
  name: "security-posture-pr",
  version: "1.0.0",
  image: "registry.cloudflare.com/openhackersclub/flare-dispatch-review:latest",

  // Schedule mode: 07:00 UTC every Monday. Must also appear in wrangler.jsonc
  // `triggers.crons`.
  schedules: [
    {
      cron: "0 7 * * 1",
      idempotencyKey: ({ firedAt }) => `security-posture-pr:${isoDate(firedAt)}`,
      inputs: ({ firedAt }) => ({ firedAt }),
    },
  ],

  inputs: Input,
  outputs: Output,

  limits: { maxDurationSec: 900, maxConcurrency: 2 },

  run: (input) =>
    Effect.gen(function* () {
      const day = isoDate(input.firedAt);
      const empty: typeof Output.Type = {
        findings: 0,
        highestSeverity: "info",
        modelNarrative: false,
        prOpened: false,
        prUpdated: false,
        prNumber: 0,
      };

      // 1. Where to file the report.
      const reportRepo = yield* step("resolve-report-repo", () => config.get(REPORT_REPO_KEY));
      if (reportRepo === undefined || reportRepo.trim() === "") {
        yield* step("log-no-report-repo", () =>
          io.log(
            "warn",
            `security-posture-pr: ${REPORT_REPO_KEY} is unset — nowhere to open the audit PR; set it to your flare-dispatch fork (owner/name)`,
          ),
        );
        return empty;
      }
      const baseBranch = (yield* step("resolve-base", () => config.get(BASE_KEY))) ?? "main";
      const minSeverity = normalizeSeverity(
        yield* step("resolve-min-severity", () => config.get(MIN_SEVERITY_KEY)),
      );

      // 2. The declared plane — the operator's posture manifest. A malformed or
      //    absent value decodes to `none`; we audit an all-unknown manifest so the
      //    report still surfaces the live blast-radius and a "populate the
      //    manifest" finding rather than no-oping.
      const manifestOpt = yield* step("resolve-manifest", () =>
        config.getJSON(MANIFEST_KEY, PostureManifest),
      );
      const manifestPresent = Option.isSome(manifestOpt);
      const manifest = Option.getOrElse(manifestOpt, () =>
        Schema.decodeSync(PostureManifest)({}),
      );

      // 3. The live plane — the App's real install blast-radius. Degrades to an
      //    empty list when the deploy can't enumerate (no installation reachable
      //    from a cron tick); the audit then leans on the declared scope.
      const repos = yield* step("read-install-scope", () =>
        github.repositories({ includeArchived: true }),
      ).pipe(Effect.catchAll(() => Effect.succeed([] as readonly RepoRef[])));
      const live = summarizeBlastRadius(repos);

      // 4. Deterministic rules — the high-confidence findings, no model needed.
      const ruleFindings = evaluateRules(manifest, manifestPresent, live);

      // 5. Model pass — narrative + anything the rules missed. Best-effort: an
      //    unconfigured or failing model never sinks the audit; we keep the
      //    rules-only findings and note the narrative was skipped.
      const modelOutcome = yield* runModelPass({
        manifest,
        live,
        ruleFindings,
      });

      const findings = dedupe([...ruleFindings, ...modelOutcome.findings]).sort(
        (a, b) => rank(b.severity) - rank(a.severity),
      );
      const highest = findings.reduce<SeverityT>(
        (acc, f) => (rank(f.severity) > rank(acc) ? f.severity : acc),
        "info",
      );

      // 6. The min-severity gate. Default "info" → always file the weekly record;
      //    raise it to e.g. "medium" to only get a PR when posture regresses.
      const gating = findings.filter((f) => f.status !== "ok");
      const tripped = gating.some((f) => rank(f.severity) >= rank(minSeverity));
      if (!tripped) {
        yield* step("log-below-threshold", () =>
          io.log(
            "info",
            `security-posture-pr: ${findings.length} finding(s), highest "${highest}" below min-severity "${minSeverity}" — no PR filed`,
          ),
        );
        return { ...empty, findings: findings.length, highestSeverity: highest, modelNarrative: modelOutcome.narrated };
      }

      // 7. Open / update the single weekly audit draft PR.
      const result = yield* step("open-pr", () =>
        github.openDraftPullRequest({
          repo: reportRepo,
          baseBranch,
          headBranch: `flare-dispatch/security-posture-${day}`,
          title: `chore(security): posture review ${day} — ${gating.length} finding(s)`,
          body: renderPrBody({ summary: modelOutcome.summary, findings, live, day, narrated: modelOutcome.narrated }),
          commitMessage: `chore(security): BYOC posture review for ${day}\n\nGenerated by flare-dispatch security-posture-pr.`,
          files: [
            {
              path: `.flare-dispatch/security-posture-${day}.md`,
              content: renderReportFile({
                summary: modelOutcome.summary,
                findings,
                manifest,
                manifestPresent,
                live,
                day,
                narrated: modelOutcome.narrated,
              }),
            },
          ],
        }),
      );

      yield* io.log(
        "info",
        `security-posture-pr: ${result.created ? "opened" : "updated"} draft PR #${result.number} on ${reportRepo} (${findings.length} findings, highest ${highest})`,
      );

      return {
        findings: findings.length,
        highestSeverity: highest,
        modelNarrative: modelOutcome.narrated,
        prOpened: result.created,
        prUpdated: !result.created,
        prNumber: result.number,
      };
    }),
});

// --- Live blast-radius -------------------------------------------------------

type BlastRadius = {
  readonly introspected: boolean;
  readonly repoCount: number;
  readonly archivedCount: number;
  readonly installationCount: number;
  readonly repos: readonly string[];
};

const summarizeBlastRadius = (repos: readonly RepoRef[]): BlastRadius => ({
  introspected: repos.length > 0,
  repoCount: repos.length,
  archivedCount: repos.filter((r) => r.archived).length,
  installationCount: new Set(repos.map((r) => r.installationId)).size,
  repos: repos.map((r) => r.repo),
});

// --- Deterministic rules -----------------------------------------------------

/** The minimal App permission baseline from infra/github-app-manifest.json. */
const APP_BASELINE: Record<string, string> = {
  checks: "write",
  contents: "read",
  deployments: "read",
  metadata: "read",
  pull_requests: "write",
};
const PERM_LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** Scope substrings that signal an over-broad ("god") Cloudflare API token. */
const BROAD_CF_SCOPE = ["all accounts", "account settings", "memberships", "global", "*", "edit cloudflare workers"];

const f = (x: FindingT): FindingT => x;

/**
 * The high-confidence checks — pure `manifest × live → findings`. Each rule maps
 * to a control in specs/07-trust-model.md; the `reference` field points back at it.
 */
const evaluateRules = (
  m: PostureManifestT,
  manifestPresent: boolean,
  live: BlastRadius,
): FindingT[] => {
  const out: FindingT[] = [];

  if (!manifestPresent) {
    out.push(
      f({
        control: "posture manifest",
        principle: "defense-in-depth",
        severity: "medium",
        status: "gap",
        finding: `No declared posture manifest at CONFIG_KV ${MANIFEST_KEY} — the audit can only see the live install blast-radius, not your token scopes or DiD controls.`,
        recommendation: `Populate ${MANIFEST_KEY} (see the recipe README) so the weekly review can hold your declared posture against the least-privilege / defense-in-depth rubric.`,
        reference: "specs/05-byoc.md § Reference: ship-ready checklist",
      }),
    );
  }

  // --- Least-privilege: Cloudflare API token --------------------------------
  const scopes = m.cloudflareApiTokenScopes.map((s) => s.toLowerCase());
  if (m.cloudflareApiTokenScopes.length === 0) {
    out.push(
      f({
        control: "CLOUDFLARE_API_TOKEN scope",
        principle: "least-privilege",
        severity: "low",
        status: "unknown",
        finding: "No CF API-token scopes declared — least-privilege of the deploy/read token can't be assessed.",
        recommendation: "List the token's granted permission groups in the manifest. The token used by `wrangler` is the root credential — keep it to exactly the resources this deploy touches.",
        reference: "specs/07-trust-model.md § Protect the Cloudflare API token",
      }),
    );
  } else {
    const broad = m.cloudflareApiTokenScopes.filter((s) =>
      BROAD_CF_SCOPE.some((b) => s.toLowerCase().includes(b)),
    );
    if (broad.length > 0) {
      out.push(
        f({
          control: "CLOUDFLARE_API_TOKEN scope",
          principle: "least-privilege",
          severity: "high",
          status: "gap",
          finding: `CF API token carries broad/account-wide scope(s): ${broad.join(", ")}. A leak of this token can redeploy the Worker, read every Worker Secret, and exfiltrate CONFIG_KV.`,
          recommendation: "Replace with a token scoped to only the resources this deploy edits (Workers Scripts, the named KV/D1/R2, Containers, and DNS/Routes only if it provisions the custom domain). Drop account-settings / membership scopes.",
          reference: "specs/07-trust-model.md § Protect the Cloudflare API token",
        }),
      );
    }
    const purpose = m.cloudflareApiTokenPurpose.toLowerCase();
    const hasEdit = scopes.some((s) => s.includes("edit") || s.includes("write"));
    if (purpose.includes("read") && !purpose.includes("deploy") && hasEdit) {
      out.push(
        f({
          control: "CLOUDFLARE_API_TOKEN scope",
          principle: "least-privilege",
          severity: "medium",
          status: "gap",
          finding: "The CF token is declared read-purpose (e.g. ci-triage deployments read) yet holds edit/write scopes.",
          recommendation: "Issue a separate read-only token (e.g. Pages/Deployments:Read) for the read path; keep edit scopes on the deploy token only.",
          reference: "specs/07-trust-model.md § Protect the Cloudflare API token",
        }),
      );
    }
    // The known freeze gotcha — a deploy token missing Containers:Edit silently
    // fails container deploys.
    if (purpose.includes("deploy") && !scopes.some((s) => s.includes("container"))) {
      out.push(
        f({
          control: "CLOUDFLARE_API_TOKEN scope",
          principle: "least-privilege",
          severity: "low",
          status: "gap",
          finding: "Deploy token has no Containers scope declared — container/DO deploys can silently fail, freezing prod on stale code.",
          recommendation: "Add Workers Containers (Edit) to the deploy token so `wrangler deploy` can update the container images.",
          reference: "specs/05-byoc.md § Wrangler config",
        }),
      );
    }
  }

  // --- Least-privilege + blast-radius: GitHub App ---------------------------
  const perms = Object.entries(m.githubAppPermissions);
  if (perms.length === 0) {
    out.push(
      f({
        control: "GitHub App permissions",
        principle: "least-privilege",
        severity: "low",
        status: "unknown",
        finding: "No App permission set declared — can't compare against the minimal baseline (checks:write, contents/deployments/metadata:read, pull_requests:write).",
        recommendation: "Declare githubAppPermissions in the manifest. The App key is the worst-case crown jewel; keep its grant minimal.",
        reference: "specs/07-trust-model.md § Compromised GitHub App installation",
      }),
    );
  } else {
    for (const [scope, level] of perms) {
      const base = APP_BASELINE[scope];
      const lvl = PERM_LEVEL[level.toLowerCase()] ?? 0;
      if (base === undefined) {
        out.push(
          f({
            control: `GitHub App permission: ${scope}`,
            principle: "least-privilege",
            severity: lvl >= 2 ? "high" : "medium",
            status: "gap",
            finding: `App holds "${scope}: ${level}", which is beyond the minimal FlareDispatch baseline — it widens the blast-radius of a leaked App key.`,
            recommendation: `Remove "${scope}" from the App unless a run genuinely needs it.`,
            reference: "specs/07-trust-model.md § Compromised GitHub App installation",
          }),
        );
      } else if (lvl > (PERM_LEVEL[base] ?? 0)) {
        out.push(
          f({
            control: `GitHub App permission: ${scope}`,
            principle: "least-privilege",
            severity: "high",
            status: "gap",
            finding: `App grants "${scope}: ${level}" but the baseline is "${scope}: ${base}" — an over-grant.`,
            recommendation: `Lower "${scope}" to "${base}".`,
            reference: "specs/07-trust-model.md § Compromised GitHub App installation",
          }),
        );
      }
    }
  }

  // Install scope — selected-repos beats org-wide "all".
  if (m.githubAppInstallScope === "all") {
    out.push(
      f({
        control: "GitHub App install scope",
        principle: "blast-radius",
        severity: "medium",
        status: "gap",
        finding: "App is installed on ALL repos in the org — a leaked App key reads the contents and PRs of every one of them.",
        recommendation: "Re-install on the selected repos the App actually services; org-wide install maximizes blast-radius.",
        reference: "specs/07-trust-model.md § Compromised GitHub App installation",
      }),
    );
  }

  // Live vs declared install count — surface install-scope creep.
  if (live.introspected) {
    out.push(
      f({
        control: "GitHub App install blast-radius (live)",
        principle: "blast-radius",
        severity: live.repoCount > 25 ? "medium" : "info",
        status: live.repoCount > 25 ? "gap" : "ok",
        finding: `App's key currently reaches ${live.repoCount} repo(s) across ${live.installationCount} installation(s)${live.archivedCount > 0 ? ` (${live.archivedCount} archived)` : ""}.`,
        recommendation:
          live.archivedCount > 0
            ? "Remove archived repos from the installation — they add blast-radius for zero benefit."
            : "Confirm every reachable repo still needs the App; uninstall from any it no longer services.",
        reference: "specs/07-trust-model.md § Compromised GitHub App installation",
      }),
    );
  }

  // --- Defense-in-depth: viewer surfaces ------------------------------------
  if (m.viewerAccess === "token-only") {
    out.push(
      f({
        control: "viewer Cloudflare Access (VIEWER_ACCESS_MODE)",
        principle: "defense-in-depth",
        severity: "medium",
        status: "gap",
        finding: "Viewer surfaces (/logs, /demos, /replay, /v1/executions) run in token-only mode — the capability token is the ONLY gate; there is no identity layer.",
        recommendation: "Put Cloudflare Access in front of the viewer paths and unset VIEWER_ACCESS_MODE (default-secure 'required'), so a leaked log link still requires an authenticated org member.",
        reference: "specs/07-trust-model.md § Cloudflare Access on the viewer surfaces",
      }),
    );
  }
  if (m.viewerAccess === "required" && !m.customDomain) {
    out.push(
      f({
        control: "viewer Cloudflare Access (VIEWER_ACCESS_MODE)",
        principle: "defense-in-depth",
        severity: "high",
        status: "gap",
        finding: "VIEWER_ACCESS_MODE=required but no custom domain is declared — Cloudflare Access cannot front *.workers.dev, so either the viewer 503s (access_not_configured) or Access is mis-bound.",
        recommendation: "Provision a custom domain (routes + custom_domain:true), bind ACCESS_AUD + ACCESS_TEAM_DOMAIN, and point PUBLIC_ORIGIN at it.",
        reference: "specs/07-trust-model.md § Cloudflare Access on the viewer surfaces",
      }),
    );
  }

  // --- Defense-in-depth: admin surface --------------------------------------
  if (m.adminToken === "set" && !m.adminAccessFronted) {
    out.push(
      f({
        control: "admin surface (/v1/admin/*)",
        principle: "defense-in-depth",
        severity: "medium",
        status: "gap",
        finding: "ADMIN_TOKEN is set but no Cloudflare Access fronts /v1/admin/* — a single bearer token is the only thing gating the signalling route.",
        recommendation: "Add a Cloudflare Access application over /v1/admin/* as defense-in-depth on top of the ADMIN_TOKEN bearer gate.",
        reference: "specs/07-trust-model.md § Admin surface",
      }),
    );
  }

  // --- Secret hygiene -------------------------------------------------------
  const modes = m.triggerModes;
  if (modes.includes("action") && m.hmacSecret !== "set") {
    out.push(
      f({
        control: "HMAC_SECRET",
        principle: "secret-hygiene",
        severity: "high",
        status: "gap",
        finding: "Action mode is in use but HMAC_SECRET is declared unset — /v1/dispatch can't verify Action/direct-POST callers.",
        recommendation: "Set HMAC_SECRET (openssl rand -base64 32) and the matching FLAREDISPATCH_HMAC repo/org secret.",
        reference: "specs/07-trust-model.md § Compromised Action runner",
      }),
    );
  }
  if (!modes.includes("action") && modes.length > 0 && m.hmacSecret === "set") {
    out.push(
      f({
        control: "HMAC_SECRET",
        principle: "least-privilege",
        severity: "low",
        status: "gap",
        finding: "HMAC_SECRET is set but no Action/direct-POST path is in use — an unnecessary long-lived shared secret to rotate and protect.",
        recommendation: "A webhook-/schedule-only deploy can drop HMAC_SECRET entirely (log tokens fall back to it, so set LOG_LINK_SECRET first if you rely on tokened log links).",
        reference: "specs/05-byoc.md § Secrets",
      }),
    );
  }
  if (modes.includes("webhook") && m.webhookSecret !== "set") {
    out.push(
      f({
        control: "GITHUB_WEBHOOK_SECRET",
        principle: "secret-hygiene",
        severity: "medium",
        status: "gap",
        finding: "Webhook mode is declared in use but GITHUB_WEBHOOK_SECRET is unset — /v1/webhooks/github 503s, so webhook-triggered runs never fire.",
        recommendation: "Set GITHUB_WEBHOOK_SECRET to the value configured in the App's webhook settings.",
        reference: "specs/07-trust-model.md § Hostile webhook source",
      }),
    );
  }
  if (m.browserCdpToken === "set") {
    out.push(
      f({
        control: "BROWSER_CDP_API_TOKEN",
        principle: "secret-hygiene",
        severity: "medium",
        status: "gap",
        finding: "BROWSER_CDP_API_TOKEN is a long-lived static credential with no built-in TTL, and it IS exposed to the CDP container process (a known gap).",
        recommendation: "Rotate it on a fixed cadence via `wrangler secret put`; track the per-run short-lived bridge-token hardening.",
        reference: "specs/07-trust-model.md § BROWSER_CDP_API_TOKEN is a long-lived static credential",
      }),
    );
  }
  if (m.oidcFederation && m.secretRotationDays === 0) {
    out.push(
      f({
        control: "OIDC_SIGNING_JWK rotation",
        principle: "secret-hygiene",
        severity: "low",
        status: "gap",
        finding: "A run federates to AWS/GCP via OIDC but no key-rotation cadence is declared.",
        recommendation: "Declare and automate an OIDC_SIGNING_JWK rotation cadence (keygen | wrangler secret put; AWS picks up the new kid on the next exchange).",
        reference: "specs/05-byoc.md § AWS federation trust policy",
      }),
    );
  }
  if (m.secretRotationDays === 0 || m.secretRotationDays > 90) {
    out.push(
      f({
        control: "secret rotation cadence",
        principle: "secret-hygiene",
        severity: "low",
        status: "gap",
        finding:
          m.secretRotationDays === 0
            ? "No secret-rotation cadence declared for HMAC_SECRET / GITHUB_APP_PRIVATE_KEY / GITHUB_WEBHOOK_SECRET."
            : `Declared rotation cadence is ${m.secretRotationDays} days (> 90) — long-lived secrets drift toward stale.`,
        recommendation: "Declare a ≤90-day rotation cadence and keep the rotation playbook (regenerate → wrangler secret put → confirm 401 fingerprints match) at hand.",
        reference: "specs/07-trust-model.md § Rotate the HMAC secret on suspected leak",
      }),
    );
  }

  return out;
};

// --- Model pass (best-effort) ------------------------------------------------

const RULES_ONLY_SUMMARY =
  "Model narrative skipped (backend unconfigured or unavailable) — this report carries the deterministic rule findings only.";

const REVIEW_JSON_CONTRACT = `{"summary":string,"findings":[{"control":string,"principle":"least-privilege"|"defense-in-depth"|"secret-hygiene"|"blast-radius"|"platform-residual","severity":"info"|"low"|"medium"|"high"|"critical","status":"ok"|"gap"|"unknown","finding":string,"recommendation":string,"reference":string}]}`;

const runModelPass = (ctx: {
  manifest: PostureManifestT;
  live: BlastRadius;
  ruleFindings: readonly FindingT[];
}) =>
  Effect.gen(function* () {
    const resolved = yield* step("resolve-backend", () =>
      resolveBackend((k) => config.get(k), { namespace: NAMESPACE }),
    ).pipe(Effect.option);

    if (Option.isNone(resolved)) {
      yield* io.log(
        "warn",
        "security-posture-pr: review backend unconfigured — filing rules-only report",
      );
      return { narrated: false, summary: RULES_ONLY_SUMMARY, findings: [] };
    }
    const backend = resolved.value;

    const systemPrompt =
      (yield* step("resolve-prompt", () => config.get(promptKey(NAMESPACE)))) ??
      DEFAULT_AUDITOR_PROMPT;

    const review = yield* step("review", () =>
      completeStructured({
        backend: backend.backend,
        model: backend.model,
        mode: backend.mode,
        system: systemPrompt,
        userBody: renderUserBody(ctx),
        jsonContract: REVIEW_JSON_CONTRACT,
        schema: PostureReview,
        toolName: "report_posture",
        toolDescription: "Report the security-posture review of the FlareDispatch deployment.",
        surface: "security-posture",
        maxTokens: REVIEW_MAX_TOKENS,
      }),
    ).pipe(Effect.option);

    return Option.match(review, {
      onNone: () => ({
        narrated: false,
        summary: RULES_ONLY_SUMMARY,
        findings: [] as readonly FindingT[],
      }),
      onSome: (r) => ({ narrated: true, summary: r.summary.trim(), findings: r.findings }),
    });
  }).pipe(
    // Belt-and-suspenders: ANY unexpected error in the model pass degrades to
    // rules-only rather than failing the audit. A StepFailed escaping here would
    // mean the weekly security review silently stops.
    Effect.catchAll((e) =>
      Effect.as(
        io.log("warn", `security-posture-pr: model pass failed (${describeError(e)}) — rules-only report`),
        { narrated: false, summary: RULES_ONLY_SUMMARY, findings: [] as readonly FindingT[] },
      ),
    ),
  );

const describeError = (e: unknown): string =>
  e instanceof StepFailed ? `${e.step}: ${e.cause}` : String(e);

// --- Rendering ---------------------------------------------------------------

const SEVERITY_BADGE: Record<SeverityT, string> = {
  critical: "🟥 critical",
  high: "🟧 high",
  medium: "🟨 medium",
  low: "⬜ low",
  info: "🔵 info",
};

const dedupe = (findings: readonly FindingT[]): FindingT[] => {
  const seen = new Set<string>();
  const out: FindingT[] = [];
  for (const x of findings) {
    const id = `${x.control}|${x.finding}`.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(x);
  }
  return out;
};

const renderUserBody = (ctx: {
  manifest: PostureManifestT;
  live: BlastRadius;
  ruleFindings: readonly FindingT[];
}): string =>
  [
    "## Live install blast-radius (introspected)",
    ctx.live.introspected
      ? `- ${ctx.live.repoCount} repo(s) across ${ctx.live.installationCount} installation(s); ${ctx.live.archivedCount} archived.`
      : "- Not introspectable from this deploy (no installation reachable from the cron tick) — assess from the declared scope.",
    "",
    "## Declared posture manifest",
    "```json",
    JSON.stringify(ctx.manifest, null, 2),
    "```",
    "",
    "## Deterministic findings already raised (do not repeat — add what's missing)",
    ctx.ruleFindings.length === 0
      ? "- (none)"
      : ctx.ruleFindings.map((r) => `- [${r.severity}/${r.principle}] ${r.control}: ${r.finding}`).join("\n"),
  ].join("\n");

const MARKER = "<!-- flare-dispatch: security-posture-pr -->";

const principleTally = (findings: readonly FindingT[]): string => {
  const principles = ["least-privilege", "defense-in-depth", "secret-hygiene", "blast-radius", "platform-residual"];
  return principles
    .map((p) => {
      const inP = findings.filter((x) => x.principle === p && x.status !== "ok");
      const worst = inP.reduce<SeverityT>((acc, x) => (rank(x.severity) > rank(acc) ? x.severity : acc), "info");
      const mark = inP.length === 0 ? "✅ clean" : `${SEVERITY_BADGE[worst]} · ${inP.length} open`;
      return `| ${p} | ${mark} |`;
    })
    .join("\n");
};

const renderFindingRows = (findings: readonly FindingT[]): string =>
  findings
    .map(
      (x) =>
        `| ${SEVERITY_BADGE[x.severity]} | ${x.principle} | ${x.status} | ${x.control} | ${x.finding} |`,
    )
    .join("\n");

const renderPrBody = (ctx: {
  summary: string;
  findings: readonly FindingT[];
  live: BlastRadius;
  day: string;
  narrated: boolean;
}): string => {
  const open = ctx.findings.filter((x) => x.status !== "ok");
  return [
    `### BYOC security-posture review — ${ctx.day}`,
    "",
    "> 🔐 Draft opened by `flare-dispatch/security-posture-pr`. A weekly least-privilege / defense-in-depth audit of THIS FlareDispatch deployment, scored against `specs/07-trust-model.md`. Advisory — review each recommendation; nothing here is auto-applied.",
    ...(ctx.narrated ? [] : ["", "> ⚠️ Model narrative skipped — deterministic rule findings only."]),
    "",
    ctx.summary,
    "",
    "#### Scorecard",
    "| Principle | Status |",
    "|---|---|",
    principleTally(ctx.findings),
    "",
    `#### Open findings (${open.length})`,
    ...(open.length === 0
      ? ["No open findings — declared posture matches the rubric. 🎉"]
      : [
          "| Severity | Principle | Status | Control | Finding |",
          "|---|---|---|---|---|",
          renderFindingRows(open),
        ]),
    "",
    `Full report committed to \`.flare-dispatch/security-posture-${ctx.day}.md\`.`,
    "",
    MARKER,
  ].join("\n");
};

const renderReportFile = (ctx: {
  summary: string;
  findings: readonly FindingT[];
  manifest: PostureManifestT;
  manifestPresent: boolean;
  live: BlastRadius;
  day: string;
  narrated: boolean;
}): string => {
  const open = ctx.findings.filter((x) => x.status !== "ok");
  const ok = ctx.findings.filter((x) => x.status === "ok");
  return [
    `# BYOC security-posture review — ${ctx.day}`,
    "",
    ctx.narrated ? "" : "> ⚠️ Model narrative skipped — deterministic rule findings only.\n",
    ctx.summary,
    "",
    "## Scorecard",
    "| Principle | Status |",
    "|---|---|",
    principleTally(ctx.findings),
    "",
    `## Open findings (${open.length})`,
    ...(open.length === 0
      ? ["No open findings."]
      : open.flatMap((x) => [
          `### ${SEVERITY_BADGE[x.severity]} — ${x.control}`,
          `- **Principle:** ${x.principle}`,
          `- **Status:** ${x.status}`,
          `- **Finding:** ${x.finding}`,
          `- **Recommendation:** ${x.recommendation}`,
          ...(x.reference !== undefined ? [`- **Reference:** ${x.reference}`] : []),
          "",
        ])),
    ...(ok.length > 0
      ? ["## Verified sound", ...ok.map((x) => `- **${x.control}** — ${x.finding}`), ""]
      : []),
    "## Inputs",
    `- **Manifest present:** ${ctx.manifestPresent ? "yes" : `no (audited an empty manifest — populate CONFIG_KV ${MANIFEST_KEY})`}`,
    `- **Live blast-radius:** ${ctx.live.introspected ? `${ctx.live.repoCount} repo(s), ${ctx.live.installationCount} installation(s), ${ctx.live.archivedCount} archived` : "not introspectable from this deploy"}`,
    ...(ctx.live.introspected && ctx.live.repos.length > 0
      ? ["", "<details><summary>Reachable repos</summary>", "", ...ctx.live.repos.map((r) => `- ${r}`), "", "</details>"]
      : []),
    "",
    "### Declared manifest",
    "```json",
    JSON.stringify(ctx.manifest, null, 2),
    "```",
    "",
    "---",
    "_Generated by `flare-dispatch/security-posture-pr`. Posture rubric: `specs/07-trust-model.md`._",
    "",
  ].join("\n");
};
