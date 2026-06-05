import { describe, expect, it } from "vitest";
import { accessHeaderHostAllow } from "./access-scope";

describe("accessHeaderHostAllow", () => {
  it("allows exactly the app's host", () => {
    const allow = accessHeaderHostAllow(
      "https://app-staging.pages.dev/some/path",
      undefined,
    );
    expect(allow).not.toBeNull();
    expect(allow!("app-staging.pages.dev")).toBe(true);
    // Cross-origin hosts must NOT get the service token — sending it broke
    // the Clerk script load (CORS) and leaked the secret to third parties.
    expect(allow!("example.clerk.accounts.dev")).toBe(false);
    expect(allow!("fonts.gstatic.com")).toBe(false);
  });

  it("adds CF_ACCESS_HOSTS entries (exact match, whitespace-tolerant)", () => {
    const allow = accessHeaderHostAllow("https://app.pages.dev", " api.example.com , other.example.com ");
    expect(allow!("api.example.com")).toBe(true);
    expect(allow!("other.example.com")).toBe(true);
    expect(allow!("sub.api.example.com")).toBe(false);
  });

  it("works from extra hosts alone when the app url is missing/unparseable", () => {
    expect(accessHeaderHostAllow(undefined, "api.example.com")!("api.example.com")).toBe(true);
    expect(accessHeaderHostAllow("not a url", "api.example.com")!("api.example.com")).toBe(true);
  });

  it("returns null when no host information exists — caller falls back to global", () => {
    expect(accessHeaderHostAllow(undefined, undefined)).toBeNull();
    expect(accessHeaderHostAllow("not a url", " , ")).toBeNull();
  });
});
