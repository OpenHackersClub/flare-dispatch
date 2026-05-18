// @flare-dispatch/github-app — public API.
//
// GitHub App authentication helpers for the FlareDispatch check-run callback:
//
//   * `signAppJwt`           — RS256 App JWT from the PEM private key.
//   * `getInstallationToken` — exchange the JWT for a short-lived installation
//                              token (in-memory cached, per Worker isolate).
//   * `createCheckRun` / `updateCheckRun` — post the run verdict.
//
// Provider-neutral fetch code: plain typed `async` functions, no Effect
// dependency. The Effect Layer (`ChecksGithubLive` in @flare-dispatch/runtime-cf)
// wraps these.
//
// Spec: specs/04-gha-integration.md § Check-runs callback, specs/pm/plan.md
// § PR6.

export { signAppJwt, type SignAppJwtOptions } from "./jwt";
export {
  getInstallationToken,
  __clearTokenCache,
  type GetInstallationTokenOptions,
} from "./installation-token";
export {
  createCheckRun,
  updateCheckRun,
  type CheckConclusion,
  type CheckRunOutput,
  type CreateCheckRunOptions,
  type UpdateCheckRunOptions,
} from "./check-runs";
export { GithubApiError } from "./errors";
