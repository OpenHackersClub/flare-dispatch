// Unit coverage for the detached-boot reliability surface of
// `makeSandboxCloudflareLive`: the wait-for-port timeout ceiling (A), log
// capture on a failed boot (B), and the `exposePort` reachable-URL capability
// (C).
//
// The Layer imports `@cloudflare/sandbox` for the live `getSandbox` call, which
// Node + Vitest can't resolve outside a `vitest-pool-workers` environment — so
// we `vi.mock` it to return an in-memory fake `box`. That keeps these tests in
// the plain forks pool (no Miniflare, no container runtime) while exercising the
// Effect-layer behavior the SDK's own `timeout` does not reliably enforce. The
// timeout test uses Effect's `TestClock`, so it is instant rather than waiting
// out a real 120s ceiling.
//
// Spec: specs/03-dsl.md § sandbox.

import { it } from "@effect/vitest";
import {
  Cause,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  TestClock,
} from "effect";
import { describe, expect, vi } from "vitest";
import {
  type PortNeverOpened,
  Sandbox as SandboxTag,
} from "@flare-dispatch/core";

// --- The fake `box` the mocked `getSandbox` hands back -----------------------

/** Build a fake `box` whose process/expose behavior the test controls. */
const makeFakeBox = (opts: {
  proc?: {
    waitForPort?: () => Promise<void>;
    logs?: { stdout: string; stderr: string };
    command?: string;
  } | null;
  exposePort?: (
    port: number,
    options: { hostname: string; name?: string },
  ) => Promise<{ url: string; port: number; name: string | undefined }>;
}) => {
  const getLogs = vi.fn(
    async () => opts.proc?.logs ?? { stdout: "boot stdout", stderr: "boot stderr" },
  );
  const waitForPort = vi.fn(opts.proc?.waitForPort ?? (() => Promise.resolve()));
  const proc =
    opts.proc === null
      ? null
      : {
          id: "proc-1",
          command: opts.proc?.command ?? "pnpm dev",
          waitForPort,
          getLogs,
        };
  return {
    getProcess: vi.fn(async () => proc),
    exposePort: vi.fn(
      opts.exposePort ??
        (async (port: number) => ({
          url: `https://${port}-fake.example.com`,
          port,
          name: undefined,
        })),
    ),
    _getLogs: getLogs,
    _waitForPort: waitForPort,
  };
};

// `getSandbox(ns, id)` is the only thing the Layer pulls from the SDK; the mock
// returns whatever the current test installed via `currentBox`.
let currentBox: ReturnType<typeof makeFakeBox>;
vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => currentBox,
}));

// Imported AFTER the mock is registered so the Layer binds the mocked SDK.
const { makeSandboxCloudflareLive } = await import("./sandbox-cf");

/** A minimal R2 stub that records `put` calls. */
const makeBucket = () => {
  const puts: { key: string; body: unknown }[] = [];
  const bucket = {
    put: async (key: string, body: unknown) => {
      puts.push({ key, body });
      return {} as R2Object;
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
};

// The Layer only ever passes `ns` to the (mocked) `getSandbox`, so a bare stub
// suffices; the cast satisfies the `DurableObjectNamespace<Sandbox>` parameter.
const ns = {} as Parameters<typeof makeSandboxCloudflareLive>[0];
const handle = { id: "proc-1", container: { id: "exec-1" } };

/** Pull the typed failure value off an Exit, or `undefined` on success. */
const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.failureOption(exit.cause))
    : undefined;

describe("makeSandboxCloudflareLive — waitForPort timeout (A)", () => {
  it.effect(
    "fails with PortNeverOpened at the ceiling when the SDK wait never resolves",
    () => {
      // The SDK `waitForPort` never resolves — modelling the ~17-min hang. The
      // Effect-layer ceiling must fail it fast at `timeoutSec`.
      currentBox = makeFakeBox({
        proc: { waitForPort: () => new Promise<void>(() => {}) },
      });
      const { bucket, puts } = makeBucket();
      const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");

      return Effect.gen(function* () {
        const fiber = yield* Effect.flatMap(SandboxTag, (s) =>
          s.waitForPort({ handle, port: 4173, timeoutSec: 120 }),
        ).pipe(Effect.provide(layer), Effect.exit, Effect.fork);

        // Advance virtual time past the 120s ceiling; the wait fails instantly.
        yield* TestClock.adjust(Duration.seconds(121));
        const exit = yield* Fiber.join(fiber);

        const err = failureOf<PortNeverOpened>(exit);
        expect(err?._tag).toBe("PortNeverOpened");
        expect(err?.port).toBe(4173);
        expect(err?.timeoutSec).toBe(120);

        // (B) the detached process's logs were captured to R2 on the failure
        // path, and the logPath is surfaced on the error for diagnosis.
        expect(puts.length).toBe(1);
        expect(err?.logPath).toBe(puts[0]?.key);
      });
    },
  );
});

describe("makeSandboxCloudflareLive — log capture on boot failure (B)", () => {
  it.effect(
    "captures logs and surfaces logPath when the SDK wait rejects",
    () => {
      // The SDK rejects immediately (not a hang) — still a failed boot; logs
      // must be captured and the logPath surfaced.
      currentBox = makeFakeBox({
        proc: {
          waitForPort: () => Promise.reject(new Error("port closed")),
          logs: { stdout: "starting…", stderr: "EADDRINUSE" },
        },
      });
      const { bucket, puts } = makeBucket();
      const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");

      return Effect.gen(function* () {
        const exit = yield* Effect.flatMap(SandboxTag, (s) =>
          s.waitForPort({ handle, port: 4173, timeoutSec: 120 }),
        ).pipe(Effect.provide(layer), Effect.exit);

        const err = failureOf<PortNeverOpened>(exit);
        expect(err?._tag).toBe("PortNeverOpened");
        expect(puts.length).toBe(1);
        expect(err?.logPath).toBe(puts[0]?.key);
        // The NDJSON body carries the detached process's captured stderr.
        expect(String(puts[0]?.body)).toContain("EADDRINUSE");
      });
    },
  );

  it.effect(
    "a log-capture failure does not mask the original PortNeverOpened",
    () => {
      // The process has vanished by the time we try to capture logs
      // (`getProcess` → null on the second call). The original timeout must
      // still surface — just without a logPath.
      let call = 0;
      currentBox = makeFakeBox({
        proc: {
          waitForPort: () => Promise.reject(new Error("port closed")),
        },
      });
      currentBox.getProcess = vi.fn(async () => {
        call += 1;
        // First call (inside the wait) sees the proc; the capture pass sees
        // none — the process is gone.
        return call === 1
          ? ({
              id: "proc-1",
              command: "pnpm dev",
              waitForPort: () => Promise.reject(new Error("port closed")),
              getLogs: async () => ({ stdout: "", stderr: "" }),
            } as never)
          : null;
      });
      const { bucket, puts } = makeBucket();
      const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");

      return Effect.gen(function* () {
        const exit = yield* Effect.flatMap(SandboxTag, (s) =>
          s.waitForPort({ handle, port: 4173, timeoutSec: 120 }),
        ).pipe(Effect.provide(layer), Effect.exit);

        const err = failureOf<PortNeverOpened>(exit);
        expect(err?._tag).toBe("PortNeverOpened");
        expect(err?.logPath).toBeUndefined();
        expect(puts.length).toBe(0);
      });
    },
  );
});

describe("makeSandboxCloudflareLive — exposePort (C)", () => {
  it.effect("returns the SDK preview URL, passing the preview hostname", () => {
    currentBox = makeFakeBox({
      exposePort: async (port, options) => ({
        url: `https://${port}-${options.hostname}/`,
        port,
        name: options.name,
      }),
    });
    const { bucket } = makeBucket();
    const layer = makeSandboxCloudflareLive(
      ns,
      bucket,
      "exec-1",
      undefined,
      "fd.example.workers.dev",
    );

    return Effect.gen(function* () {
      const result = yield* Effect.flatMap(SandboxTag, (s) =>
        s.exposePort({ port: 4173 }),
      ).pipe(Effect.provide(layer));

      expect(result.url).toBe("https://4173-fd.example.workers.dev/");
      expect(currentBox.exposePort).toHaveBeenCalledWith(4173, {
        hostname: "fd.example.workers.dev",
        name: undefined,
      });
    });
  });

  it.effect(
    "fails with ExposePortFailed when no preview hostname is configured",
    () => {
      currentBox = makeFakeBox({});
      const { bucket } = makeBucket();
      // No `previewHostname` — the SDK cannot build a URL, so the run fails
      // loudly rather than handing the suite an unreachable localhost.
      const layer = makeSandboxCloudflareLive(ns, bucket, "exec-1");

      return Effect.gen(function* () {
        const exit = yield* Effect.flatMap(SandboxTag, (s) =>
          s.exposePort({ port: 4173 }),
        ).pipe(Effect.provide(layer), Effect.exit);

        const err = failureOf<{ _tag: string }>(exit);
        expect(err?._tag).toBe("ExposePortFailed");
        expect(currentBox.exposePort).not.toHaveBeenCalled();
      });
    },
  );
});
