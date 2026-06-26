// Tests for the mailbox address build/parse — sub-addressing + catch-all forms.

import { describe, expect, it } from "vitest";
import {
  buildInboxAddress,
  isInboxLocalPart,
  parseInboxLocalPart,
} from "./contract";

const LP = "demo-0123456789abcdef0123456789abcd";

describe("buildInboxAddress", () => {
  it("sub-addressing form: base@domain → base+localPart@domain", () => {
    expect(buildInboxAddress(LP, "flare-dispatch-inbox@openhackers.club")).toBe(
      `flare-dispatch-inbox+${LP}@openhackers.club`,
    );
  });
  it("catch-all form: bare domain → localPart@domain", () => {
    expect(buildInboxAddress(LP, "inbox.openhackers.club")).toBe(
      `${LP}@inbox.openhackers.club`,
    );
  });
  it("tolerates a leading @ on the target", () => {
    expect(buildInboxAddress(LP, "@inbox.test")).toBe(`${LP}@inbox.test`);
  });
});

describe("parseInboxLocalPart", () => {
  it("extracts the +tag under sub-addressing", () => {
    expect(
      parseInboxLocalPart(`flare-dispatch-inbox+${LP}@openhackers.club`),
    ).toBe(LP);
  });
  it("returns the bare local-part under catch-all", () => {
    expect(parseInboxLocalPart(`${LP}@inbox.test`)).toBe(LP);
  });
  it("is case-insensitive on the envelope address", () => {
    expect(
      parseInboxLocalPart(`Flare-Dispatch-Inbox+${LP.toUpperCase()}@OpenHackers.Club`),
    ).toBe(LP);
  });
  it("rejects a non-demo tag (→ setReject)", () => {
    expect(parseInboxLocalPart("flare-dispatch-inbox+random@openhackers.club")).toBeNull();
    expect(parseInboxLocalPart("flare-dispatch-inbox@openhackers.club")).toBeNull();
    expect(parseInboxLocalPart("postmaster@openhackers.club")).toBeNull();
  });
  it("round-trips a built sub-address back to its local-part", () => {
    const addr = buildInboxAddress(LP, "flare-dispatch-inbox@openhackers.club");
    expect(parseInboxLocalPart(addr)).toBe(LP);
    expect(isInboxLocalPart(parseInboxLocalPart(addr)!)).toBe(true);
  });
});
