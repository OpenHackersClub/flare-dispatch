// HMAC verify/sign unit tests — pure `crypto.subtle`, no Worker fixture.
//
// `crypto.subtle` and `crypto.getRandomValues` are on the Node test runtime
// (Node ≥ 20 exposes the WebCrypto `globalThis.crypto`), so hmac.ts is tested
// directly with no Workers pool.

import { describe, expect, it } from "vitest";
import { SIGNATURE_HEADER, sign, verify } from "./hmac";

const SECRET = "test-hmac-secret-32-bytes-long!!";
const encoder = new TextEncoder();

describe("hmac", () => {
  it("SIGNATURE_HEADER is the documented header name", () => {
    expect(SIGNATURE_HEADER).toBe("X-FlareDispatch-Signature");
  });

  it("a signature produced by sign() verifies against the same bytes", async () => {
    const body = encoder.encode('{"run":"offload-test"}');
    const header = await sign(SECRET, body);
    expect(header.startsWith("sha256=")).toBe(true);
    expect(await verify(SECRET, header, body)).toBe(true);
  });

  it("rejects a signature made with a different secret", async () => {
    const body = encoder.encode("payload");
    const header = await sign("wrong-secret", body);
    expect(await verify(SECRET, header, body)).toBe(false);
  });

  it("rejects when the body bytes differ by one octet", async () => {
    const header = await sign(SECRET, encoder.encode("payload-A"));
    expect(await verify(SECRET, header, encoder.encode("payload-B"))).toBe(
      false,
    );
  });

  it("rejects a missing/empty/malformed header", async () => {
    const body = encoder.encode("payload");
    expect(await verify(SECRET, null, body)).toBe(false);
    expect(await verify(SECRET, undefined, body)).toBe(false);
    expect(await verify(SECRET, "", body)).toBe(false);
    // no sha256= prefix
    expect(await verify(SECRET, "deadbeef", body)).toBe(false);
    // odd-length hex
    expect(await verify(SECRET, "sha256=abc", body)).toBe(false);
    // non-hex chars
    expect(await verify(SECRET, "sha256=zzzz", body)).toBe(false);
    // right prefix, wrong length (not 32 bytes)
    expect(await verify(SECRET, "sha256=00", body)).toBe(false);
  });

  it("verifies raw bytes — no JSON normalization (key order matters)", async () => {
    // The signer signs exact bytes; re-serializing with different key order
    // produces different octets → the MAC must not match.
    const bytesA = encoder.encode('{"a":1,"b":2}');
    const bytesB = encoder.encode('{"b":2,"a":1}');
    const header = await sign(SECRET, bytesA);
    expect(await verify(SECRET, header, bytesA)).toBe(true);
    expect(await verify(SECRET, header, bytesB)).toBe(false);
  });
});
