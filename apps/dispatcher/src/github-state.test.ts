// Unit tests for the GitHub manifest-exchange state token (github-state.ts).
//
// All freshness paths take `ts`/`now` as parameters, so time is pinned without
// fakes. Crypto uses Node's WebCrypto (Node 22 — see package.json `engines`).

import { describe, expect, it } from "vitest";
import {
  signState,
  STATE_TTL_SECS,
  verifyState,
  type StateVerifyResult,
} from "./github-state";

const SECRET = "test-hmac-secret-32-bytes-aaaaaaa";

describe("github-state", () => {
  it("a freshly signed token verifies under the same secret", async () => {
    const ts = 1_700_000_000;
    const token = await signState(SECRET, ts, "0123456789abcdef");
    const result = await verifyState(SECRET, token, ts);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ts).toBe(ts);
      expect(result.nonce).toBe("0123456789abcdef");
    }
  });

  it("the format is `v1.<ts>.<nonce>.<32hex>`", async () => {
    const token = await signState(SECRET, 1_700_000_000, "0123456789abcdef");
    expect(token).toMatch(/^v1\.1700000000\.[0-9a-f]{16}\.[0-9a-f]{32}$/);
  });

  it("rejects a token signed with a different secret", async () => {
    const ts = 1_700_000_000;
    const token = await signState("the-wrong-secret", ts);
    const result = await verifyState(SECRET, token, ts);
    expect(result).toEqual<StateVerifyResult>({ ok: false, reason: "bad_mac" });
  });

  it("rejects a tampered nonce (MAC mismatch)", async () => {
    const ts = 1_700_000_000;
    const token = await signState(SECRET, ts, "0123456789abcdef");
    const tampered = token.replace(
      "0123456789abcdef",
      "fedcba9876543210",
    );
    const result = await verifyState(SECRET, tampered, ts);
    expect(result).toEqual<StateVerifyResult>({ ok: false, reason: "bad_mac" });
  });

  it("rejects an expired token (older than STATE_TTL_SECS)", async () => {
    const ts = 1_700_000_000;
    const token = await signState(SECRET, ts);
    const result = await verifyState(SECRET, token, ts + STATE_TTL_SECS + 1);
    expect(result).toEqual<StateVerifyResult>({ ok: false, reason: "expired" });
  });

  it("accepts a token exactly at the TTL boundary", async () => {
    const ts = 1_700_000_000;
    const token = await signState(SECRET, ts);
    const result = await verifyState(SECRET, token, ts + STATE_TTL_SECS);
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed shape", async () => {
    expect(await verifyState(SECRET, "", 1_700_000_000)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyState(SECRET, "nope", 1_700_000_000)).toEqual({
      ok: false,
      reason: "malformed",
    });
    // wrong segment count
    expect(await verifyState(SECRET, "v1.1.2", 1_700_000_000)).toEqual({
      ok: false,
      reason: "malformed",
    });
    // non-hex nonce
    expect(
      await verifyState(
        SECRET,
        "v1.1700000000.ZZZZZZZZZZZZZZZZ.00000000000000000000000000000000",
        1_700_000_000,
      ),
    ).toEqual({ ok: false, reason: "malformed" });
    // wrong mac length
    expect(
      await verifyState(
        SECRET,
        "v1.1700000000.0123456789abcdef.deadbeef",
        1_700_000_000,
      ),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects an unknown version prefix", async () => {
    const ts = 1_700_000_000;
    const result = await verifyState(
      SECRET,
      `v2.${ts}.0123456789abcdef.${"a".repeat(32)}`,
      ts,
    );
    expect(result).toEqual({ ok: false, reason: "bad_version" });
  });

  it("the input prefix `github-state.v1.` namespaces it away from dispatch MACs", async () => {
    // The dispatch HMAC signs raw request bodies under the same secret. A
    // state token MUST NOT verify as a (truncated) dispatch MAC — and
    // vice-versa — even though the key is shared. The namespace prefix
    // achieves that: an attacker who can mint a dispatch MAC for a chosen
    // string `ts.nonce` would still produce a different output than the
    // state MAC because we prepend `github-state.v1.` to the input.
    const ts = 1_700_000_000;
    const nonce = "0123456789abcdef";
    const token = await signState(SECRET, ts, nonce);
    // Naive un-namespaced MAC for the same payload — must differ from the
    // mac segment of `token`.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${ts}.${nonce}`),
    );
    const unnamespacedHex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
    const tokenMac = token.split(".")[3];
    expect(tokenMac).not.toBe(unnamespacedHex);
  });
});
