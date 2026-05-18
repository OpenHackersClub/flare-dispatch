// Cross-check: the GHA Action's `dispatch.sh` signing path must produce a MAC
// the Dispatcher's `verify()` accepts.
//
// `dispatch.sh` signs with:  openssl dgst -sha256 -hmac "$SECRET" -binary | xxd -p
// `hmac.ts` verifies with:    crypto.subtle.verify("HMAC", ...) over raw bytes.
//
// This test runs the EXACT openssl|xxd pipeline from dispatch.sh on a sample
// body, then asserts (a) the hex equals what `sign()` (crypto.subtle) produces
// and (b) `verify()` accepts the `sha256=<hex>` header. If the two signing
// implementations ever diverge, this fails — the raw-bytes contract is the
// load-bearing invariant between the Action and the Worker.

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sign, verify } from "./hmac";

const SECRET = "test-hmac-secret-32-bytes-aaaaaaa";
const SAMPLE_BODY = JSON.stringify({
  run: "offload-test",
  github: {
    repo: "owner/test-repo",
    ref: "refs/heads/main",
    sha: "abc123",
    installation_id: 12345,
  },
  inputs: { repo: "owner/test-repo", sha: "abc123", command: "pnpm test" },
  trigger: {},
});

/** Reproduce dispatch.sh's signing pipeline: openssl dgst | xxd -p. */
const opensslHmacHex = (secret: string, body: string): string => {
  const digest = execFileSync(
    "openssl",
    ["dgst", "-sha256", "-hmac", secret, "-binary"],
    { input: body },
  );
  return execFileSync("xxd", ["-p", "-c", "256"], { input: digest })
    .toString()
    .trim();
};

describe("dispatch.sh ↔ hmac.ts HMAC cross-check", () => {
  it("openssl|xxd hex equals crypto.subtle sign() over the same raw bytes", async () => {
    const opensslHex = opensslHmacHex(SECRET, SAMPLE_BODY);
    const subtleHeader = await sign(SECRET, new TextEncoder().encode(SAMPLE_BODY));

    expect(subtleHeader).toBe(`sha256=${opensslHex}`);
  });

  it("verify() accepts the sha256=<hex> header openssl produced", async () => {
    const header = `sha256=${opensslHmacHex(SECRET, SAMPLE_BODY)}`;
    const ok = await verify(
      SECRET,
      header,
      new TextEncoder().encode(SAMPLE_BODY),
    );

    expect(ok).toBe(true);
  });

  it("verify() rejects a MAC computed over a different body", async () => {
    const header = `sha256=${opensslHmacHex(SECRET, SAMPLE_BODY)}`;
    const ok = await verify(
      SECRET,
      header,
      new TextEncoder().encode(`${SAMPLE_BODY} `),
    );

    expect(ok).toBe(false);
  });
});
