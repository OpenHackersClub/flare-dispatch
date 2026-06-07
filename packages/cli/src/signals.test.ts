// Tests for the `collect-command` signal collector — the parse → validate →
// merge logic plus the `collectAndMergeSignals` orchestrator (driven with an
// injected `RunCommand` so no real process is spawned).

import { tmpdir } from "node:os";
import { Effect, Either, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { CollectCommandFailed } from "./errors.js";
import {
  type CollectOutput,
  type RunCommand,
  collectAndMergeSignals,
  existingInputSignals,
  extractSignalArray,
  mergeSignals,
  parseCollectedSignals,
  runCollectCommand,
} from "./signals.js";

const signal = (over: Record<string, unknown> = {}) => ({
  source: "workers-observability:my-api",
  title: "Unhandled exception",
  detail: "TypeError: cannot read properties of undefined",
  ...over,
});

/** A `RunCommand` that returns fixed stdout/stderr without spawning. */
const fakeRun =
  (out: CollectOutput): RunCommand =>
  () =>
    Effect.succeed(out);

/** A `RunCommand` that fails as a non-zero exit. */
const failingRun =
  (exitCode: number, stderrTail: string): RunCommand =>
  () =>
    Effect.fail(new CollectCommandFailed({ exitCode, stderrTail }));

describe("extractSignalArray", () => {
  it("accepts a bare array", () => {
    const r = extractSignalArray([signal()]);
    expect(Either.isRight(r)).toBe(true);
  });

  it("accepts an object with a `signals` array", () => {
    const r = extractSignalArray({ signals: [signal()] });
    expect(Either.getOrThrow(r)).toHaveLength(1);
  });

  it("rejects an object whose `signals` is not an array", () => {
    const r = extractSignalArray({ signals: "nope" });
    expect(Either.isLeft(r)).toBe(true);
  });

  it("rejects a non-array, non-`signals` object", () => {
    const r = extractSignalArray({ foo: "bar" });
    expect(Either.isLeft(r)).toBe(true);
  });
});

describe("parseCollectedSignals", () => {
  it("parses a bare-array payload", () => {
    const r = parseCollectedSignals(JSON.stringify([signal()]));
    expect(Either.getOrThrow(r)).toEqual([signal()]);
  });

  it("parses a `{ signals: [...] }` payload", () => {
    const r = parseCollectedSignals(JSON.stringify({ signals: [signal()] }));
    expect(Either.getOrThrow(r)).toHaveLength(1);
  });

  it("rejects non-JSON stdout", () => {
    const r = parseCollectedSignals("not json at all");
    expect(Either.isLeft(r)).toBe(true);
  });

  it("rejects empty stdout (collector must print at least `[]`)", () => {
    const r = parseCollectedSignals("   ");
    expect(Either.isLeft(r)).toBe(true);
  });

  it("rejects a payload that violates the caps (over-long detail)", () => {
    const bad = signal({ detail: "x".repeat(2_001) });
    const r = parseCollectedSignals(JSON.stringify([bad]));
    expect(Either.isLeft(r)).toBe(true);
  });

  it("rejects a payload missing a required field", () => {
    const r = parseCollectedSignals(JSON.stringify([{ source: "s", title: "t" }]));
    expect(Either.isLeft(r)).toBe(true);
  });
});

describe("existingInputSignals", () => {
  it("returns [] when inputs carries no signals", () => {
    expect(Either.getOrThrow(existingInputSignals({ firedAt: 1 }))).toEqual([]);
  });

  it("returns [] for a non-object inputs", () => {
    expect(Either.getOrThrow(existingInputSignals(undefined))).toEqual([]);
  });

  it("returns the existing signals when present + valid", () => {
    const r = existingInputSignals({ signals: [signal()] });
    expect(Either.getOrThrow(r)).toHaveLength(1);
  });

  it("rejects an existing `signals` that is not an array", () => {
    expect(Either.isLeft(existingInputSignals({ signals: 5 }))).toBe(true);
  });
});

describe("mergeSignals", () => {
  it("puts caller signals first, collected appended", () => {
    const caller = [signal({ title: "caller" })];
    const collected = [signal({ title: "collected" })];
    const merged = Either.getOrThrow(mergeSignals(caller, collected));
    expect(merged.map((s) => s.title)).toEqual(["caller", "collected"]);
  });

  it("rejects when the SUM exceeds the 50-item cap", () => {
    const caller = Array.from({ length: 30 }, () => signal());
    const collected = Array.from({ length: 21 }, () => signal());
    expect(Either.isLeft(mergeSignals(caller, collected))).toBe(true);
  });

  it("accepts exactly 50 combined", () => {
    const caller = Array.from({ length: 30 }, () => signal());
    const collected = Array.from({ length: 20 }, () => signal());
    expect(Either.isRight(mergeSignals(caller, collected))).toBe(true);
  });
});

describe("collectAndMergeSignals", () => {
  const runEffect = <A, E>(eff: Effect.Effect<A, E>) =>
    Effect.runSyncExit(eff);

  it("merges collected signals onto inputs and defaults firedAt", () => {
    const eff = collectAndMergeSignals({
      command: "echo",
      cwd: "/work",
      inputs: {},
      run: fakeRun({ stdout: JSON.stringify([signal()]), stderr: "" }),
      now: () => 1234,
    });
    const exit = runEffect(eff);
    const inputs = Exit.isSuccess(exit)
      ? (exit.value as { signals: unknown[]; firedAt: number })
      : { signals: [], firedAt: 0 };
    expect(inputs.signals).toHaveLength(1);
    expect(inputs.firedAt).toBe(1234); // defaulted because none was supplied
  });

  it("preserves a caller-supplied firedAt", () => {
    const eff = collectAndMergeSignals({
      command: "echo",
      cwd: "/work",
      inputs: { firedAt: 999 },
      run: fakeRun({ stdout: JSON.stringify([signal()]), stderr: "" }),
      now: () => 1234,
    });
    const exit = runEffect(eff);
    const inputs = Exit.isSuccess(exit)
      ? (exit.value as { firedAt: number })
      : undefined;
    expect(inputs?.firedAt).toBe(999);
  });

  it("appends collected AFTER caller-provided signals", () => {
    const eff = collectAndMergeSignals({
      command: "echo",
      cwd: "/work",
      inputs: { signals: [signal({ title: "caller" })] },
      run: fakeRun({ stdout: JSON.stringify([signal({ title: "collected" })]), stderr: "" }),
    });
    const exit = runEffect(eff);
    const inputs = Exit.isSuccess(exit)
      ? (exit.value as { signals: { title: string }[] })
      : { signals: [] };
    expect(inputs.signals.map((s) => s.title)).toEqual(["caller", "collected"]);
  });

  it("does not default firedAt when no signals result", () => {
    const eff = collectAndMergeSignals({
      command: "echo",
      cwd: "/work",
      inputs: { command: "pnpm test" },
      run: fakeRun({ stdout: "[]", stderr: "" }),
      now: () => 1234,
    });
    const exit = runEffect(eff);
    const inputs = Exit.isSuccess(exit)
      ? (exit.value as Record<string, unknown>)
      : {};
    expect(inputs.signals).toEqual([]);
    expect(inputs.firedAt).toBeUndefined();
    expect(inputs.command).toBe("pnpm test"); // other inputs preserved
  });

  it("fails (SignalsInvalid) on malformed collector output", () => {
    const eff = collectAndMergeSignals({
      command: "echo",
      cwd: "/work",
      inputs: {},
      run: fakeRun({ stdout: "not json", stderr: "" }),
    });
    const exit = runEffect(eff);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("fails (CollectCommandFailed) when the command exits non-zero", () => {
    const eff = collectAndMergeSignals({
      command: "false",
      cwd: "/work",
      inputs: {},
      run: failingRun(2, "boom"),
    });
    const exit = runEffect(eff);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("fails when the merged total exceeds the cap", () => {
    const caller = Array.from({ length: 40 }, () => signal());
    const collected = Array.from({ length: 20 }, () => signal());
    const eff = collectAndMergeSignals({
      command: "echo",
      cwd: "/work",
      inputs: { signals: caller },
      run: fakeRun({ stdout: JSON.stringify(collected), stderr: "" }),
    });
    expect(Exit.isFailure(runEffect(eff))).toBe(true);
  });
});

describe("runCollectCommand (real process)", () => {
  it("captures stdout from a real shell command", () => {
    const payload = JSON.stringify([signal()]);
    // Single-quote the JSON so the shell passes it through verbatim.
    const exit = Effect.runSyncExit(
      runCollectCommand(`printf '%s' '${payload}'`, tmpdir()),
    );
    const out = Exit.isSuccess(exit) ? exit.value.stdout : "";
    expect(JSON.parse(out)).toHaveLength(1);
  });

  it("maps a non-zero exit to CollectCommandFailed", () => {
    const exit = Effect.runSyncExit(
      runCollectCommand("exit 3", tmpdir()),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
