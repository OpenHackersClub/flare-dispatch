// Recipe: provision a user through an OTP / magic-link login — the
// `email-otp-login` Run (teaching copy; canonical impl: runs/email-otp-login.ts).
//
// The worked example of the `mailbox` capability. A run hands an auth API a
// FRESH disposable address, waits for the verification email to land in your
// Cloudflare Email Routing catch-all, and verifies the code/link — no seeded
// fixture user, no shared mailbox. The two import paths keep the DSL layering
// visible: capabilities + the run frame from `@flare-dispatch/core`, the
// reusable OTP loop from `@flare-dispatch/core/primitives`.
//
// This is the API-level driver (no browser): `curl` the auth endpoints, wait
// in-Worker on `step.waitForEvent`. For a flow that drives a real login FORM,
// see ./README.md § "Browser driver" — the container reads the code back via the
// token-gated `GET /v1/mailbox/:localPart` route instead.

import { Effect, Schema } from "effect";
import { AcceptanceFailed, defineRun, io, sandbox, step } from "@flare-dispatch/core";
import { provisionInbox, waitForOtp } from "@flare-dispatch/core/primitives";

const fillTemplate = (
  template: string,
  vars: Readonly<Record<string, string>>,
): string => template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");

const EmailOtpLoginInput = Schema.Struct({
  baseURL: Schema.String, // empty → logged no-op (skip)
  startPath: Schema.optionalWith(Schema.String, { default: () => "/api/auth/otp/start" }),
  startBody: Schema.optionalWith(Schema.String, { default: () => `{"email":"{{email}}"}` }),
  verifyPath: Schema.optionalWith(Schema.String, { default: () => "/api/auth/otp/verify" }),
  verifyBody: Schema.optionalWith(Schema.String, {
    default: () => `{"email":"{{email}}","code":"{{code}}"}`,
  }),
  codePattern: Schema.optional(Schema.String),
  linkHost: Schema.optional(Schema.String),
  expectStatus: Schema.optionalWith(Schema.Number, { default: () => 200 }),
  waitSeconds: Schema.optionalWith(Schema.Number, { default: () => 120 }),
});

const curl = (args: readonly string[]) =>
  Effect.gen(function* () {
    const r = yield* sandbox.exec({
      command: ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", ...args],
    });
    const status = Number(r.stdout.trim());
    return { status, ok: r.exitCode === 0 && status >= 200 && status < 400 };
  });

export const emailOtpLogin = defineRun({
  name: "email-otp-login",
  version: "1.0.0",
  inputs: EmailOtpLoginInput,
  outputs: Schema.Struct({
    provisionedAddress: Schema.String,
    loggedIn: Schema.Boolean,
    mode: Schema.Literal("code", "link", "skipped"),
    status: Schema.Number,
  }),
  limits: { maxDurationSec: 300 },

  run: (input) =>
    Effect.gen(function* () {
      if (input.baseURL.trim().length === 0) {
        return { provisionedAddress: "", loggedIn: false, mode: "skipped" as const, status: 0 };
      }
      const base = input.baseURL.replace(/\/$/, "");

      // 1. Provision a disposable inbox (checkpointed via the `step` inside
      //    `provisionInbox`, so replay returns the same address).
      const inbox = yield* provisionInbox();

      // 2. Ask the auth API to email this address.
      const start = yield* step("otp-start", () =>
        curl([
          "-X", "POST", "-H", "content-type: application/json",
          "-d", fillTemplate(input.startBody, { email: inbox.address }),
          `${base}${input.startPath}`,
        ]),
      );
      if (!start.ok) {
        return yield* Effect.fail(
          new AcceptanceFailed({ exitCode: 1, summaryMd: `OTP start → ${start.status}` }),
        );
      }

      // 3. Hibernate until the verification email lands, then extract.
      const otp = yield* waitForOtp({
        inbox,
        timeout: `${input.waitSeconds} seconds`,
        ...(input.codePattern !== undefined ? { codePattern: new RegExp(input.codePattern) } : {}),
        ...(input.linkHost !== undefined ? { linkHost: input.linkHost } : {}),
      });

      // 4. Verify — type the code, or follow the magic link.
      if (otp.code !== undefined) {
        const v = yield* step("otp-verify", () =>
          curl([
            "-X", "POST", "-H", "content-type: application/json",
            "-d", fillTemplate(input.verifyBody, { email: inbox.address, code: otp.code! }),
            `${base}${input.verifyPath}`,
          ]),
        );
        if (v.status !== input.expectStatus) {
          return yield* Effect.fail(
            new AcceptanceFailed({ exitCode: 1, summaryMd: `verify → ${v.status}` }),
          );
        }
        yield* io.log("info", `logged in ${inbox.address} via code`);
        return { provisionedAddress: inbox.address, loggedIn: true, mode: "code" as const, status: v.status };
      }
      if (otp.link !== undefined) {
        const f = yield* step("otp-magic-link", () => curl([otp.link!]));
        if (!f.ok) {
          return yield* Effect.fail(
            new AcceptanceFailed({ exitCode: 1, summaryMd: `magic link → ${f.status}` }),
          );
        }
        return { provisionedAddress: inbox.address, loggedIn: true, mode: "link" as const, status: f.status };
      }
      return yield* Effect.fail(
        new AcceptanceFailed({ exitCode: 1, summaryMd: "no code or link in the email" }),
      );
    }),
});
