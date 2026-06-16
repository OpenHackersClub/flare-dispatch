// Unit coverage for the agent/v1 heal logic. No filesystem, no network — the
// model call and file I/O are injected.

import { describe, expect, it, vi } from "vitest";
import {
  PROPOSE_FIX_TOOL,
  isSafeRepoPath,
  parseProposeFix,
  renderUserMessage,
  runHeal,
  type CallModel,
  type HealIo,
  type IncidentPack,
} from "./heal";

const pack: IncidentPack = {
  contractVersion: "v1",
  incidentId: "abc",
  class: "ci",
  repo: "owner/name",
  diagnosis: { title: "TypeError", area: "github-actions", diagnosis: "undefined access", suggestedFix: "guard it" },
  suspectFiles: ["src/handler.ts"],
  repro: { kind: "command", command: "pnpm test" },
  ciFailures: [{ kind: "run-step", name: "test", conclusion: "failure", logTail: "TypeError: x of undefined" }],
};

const memIo = (initial: Record<string, string> = {}): HealIo & { files: Record<string, string> } => {
  const files = { ...initial };
  return {
    files,
    readFile: async (p) => files[p],
    writeFile: async (p, c) => {
      files[p] = c;
    },
  };
};

const fixCall = (args: unknown): Awaited<ReturnType<CallModel>> => ({
  toolCalls: [{ name: "propose_fix", arguments: args }],
  text: "",
  inputTokens: 100,
  outputTokens: 50,
});

describe("renderUserMessage", () => {
  it("fences untrusted telemetry and includes suspect files", () => {
    const msg = renderUserMessage(pack, [{ path: "src/handler.ts", content: "code" }]);
    expect(msg).toContain("=== src/handler.ts ===");
    expect(msg).toContain("--- UNTRUSTED");
    expect(msg).toContain("TypeError: x of undefined");
  });
});

describe("parseProposeFix", () => {
  it("parses an object", () => {
    expect(parseProposeFix({ outcome: "patched" })?.outcome).toBe("patched");
  });
  it("parses a JSON string (some backends double-encode)", () => {
    expect(parseProposeFix('{"outcome":"no-fix"}')?.outcome).toBe("no-fix");
  });
  it("returns undefined for garbage", () => {
    expect(parseProposeFix("not json")).toBeUndefined();
  });
});

describe("runHeal", () => {
  it("applies proposed edits and reports patched", async () => {
    const io = memIo({ "src/handler.ts": "old" });
    let lastReq: Parameters<CallModel>[0] | undefined;
    const callModel: CallModel = async (req) => {
      lastReq = req;
      return fixCall({
        outcome: "patched",
        summary: "guarded the access",
        confidence: 0.8,
        files: [{ path: "src/handler.ts", content: "new safe code" }],
        addedTests: ["src/handler.test.ts"],
      });
    };
    const r = await runHeal({ pack, io, callModel });
    expect(r.outcome).toBe("patched");
    expect(r.changedFiles).toEqual(["src/handler.ts"]);
    expect(io.files["src/handler.ts"]).toBe("new safe code");
    expect(r.addedTests).toEqual(["src/handler.test.ts"]);
    expect(r.tokensUsed).toBe(150);
    // The forced tool was offered.
    expect(lastReq?.tools).toEqual([PROPOSE_FIX_TOOL]);
  });

  it("reports no-fix when the model declines", async () => {
    const io = memIo({ "src/handler.ts": "old" });
    const r = await runHeal({
      pack,
      io,
      callModel: async () => fixCall({ outcome: "no-fix", summary: "cannot tell", confidence: 0.1 }),
    });
    expect(r.outcome).toBe("no-fix");
    expect(r.changedFiles).toEqual([]);
    expect(io.files["src/handler.ts"]).toBe("old"); // untouched
  });

  it("reports needs-human and applies nothing", async () => {
    const io = memIo();
    const r = await runHeal({
      pack,
      io,
      callModel: async () => fixCall({ outcome: "needs-human", summary: "risky" }),
    });
    expect(r.outcome).toBe("needs-human");
  });

  it("reports no-fix when there is no tool call", async () => {
    const io = memIo();
    const r = await runHeal({
      pack,
      io,
      callModel: async () => ({ toolCalls: [], text: "I think...", inputTokens: 10, outputTokens: 5 }),
    });
    expect(r.outcome).toBe("no-fix");
    expect(r.tokensUsed).toBe(15);
  });

  it("only reads suspect files that exist", async () => {
    const io = memIo(); // no files
    const read = vi.spyOn(io, "readFile");
    await runHeal({ pack, io, callModel: async () => fixCall({ outcome: "no-fix" }) });
    expect(read).toHaveBeenCalledWith("src/handler.ts");
  });

  it("DROPS unsafe paths (traversal/absolute/.git) — never writes outside the clone", async () => {
    const io = memIo({ "src/handler.ts": "old" });
    const write = vi.spyOn(io, "writeFile");
    const r = await runHeal({
      pack,
      io,
      callModel: async () =>
        fixCall({
          outcome: "patched",
          summary: "evil",
          files: [
            { path: "../../etc/passwd", content: "x" },
            { path: "/etc/cron.d/x", content: "x" },
            { path: ".git/hooks/post-checkout", content: "x" },
            { path: "src/handler.ts", content: "safe edit" },
          ],
        }),
    });
    // Only the in-clone file was written.
    expect([...r.changedFiles]).toEqual(["src/handler.ts"]);
    expect(io.files["src/handler.ts"]).toBe("safe edit");
    for (const [p] of write.mock.calls) expect(isSafeRepoPath(p)).toBe(true);
    expect(r.summary).toContain("dropped 3 unsafe path");
  });

  it("all-unsafe fix → needs-human (not a silent no-op)", async () => {
    const io = memIo();
    const r = await runHeal({
      pack,
      io,
      callModel: async () => fixCall({ outcome: "patched", files: [{ path: "../x", content: "y" }] }),
    });
    expect(r.outcome).toBe("needs-human");
    expect(r.changedFiles).toEqual([]);
  });
});

describe("isSafeRepoPath", () => {
  it.each(["src/a.ts", "a/b/c.ts", "x.ts", "deep/nested/file.test.ts"])("accepts %s", (p) => {
    expect(isSafeRepoPath(p)).toBe(true);
  });
  it.each(["", "/abs", "../up", "a/../b", "./a", "a//b", ".git/hooks/x", "C:\\win", "a\\..\\b"])(
    "rejects %s",
    (p) => {
      expect(isSafeRepoPath(p)).toBe(false);
    },
  );
});
