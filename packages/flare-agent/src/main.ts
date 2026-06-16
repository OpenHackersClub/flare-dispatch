#!/usr/bin/env node
// flare-agent — CLI entry (baked into the agent-tier sandbox image).
//
//   flare-agent heal --pack <incident-pack.json>
//
// Wires the real container I/O — filesystem reads/writes relative to the clone
// (cwd), and the model call as an HTTP POST to the Worker model-proxy
// ($FLARE_MODEL_PROXY) authenticated with the per-execution capability token
// ($FLARE_AGENT_TOKEN). NO model key lives here — the Worker holds the binding.
// Writes agent-result.json (agent/v1) beside the pack and exits 0 (the run reads
// the result + captures the diff via git status --porcelain).
//
// Spec: specs/08-self-healing.md § 6.1, § 6.3.

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
import { isSafeRepoPath, runHeal, type CallModel, type IncidentPack } from "./heal";

const RESULT_FILE = "agent-result.json";

/** Minimal flag parse: `heal --pack <path>`. */
const parseArgs = (argv: string[]): { command: string; pack?: string } => {
  const command = argv[0] ?? "";
  let pack: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--pack") pack = argv[++i];
  }
  return { command, pack };
};

/** The real model call — POST to the Worker proxy. Throws on non-2xx (the proxy
 * returns 429 when the budget is exhausted; the agent halts). */
const makeCallModel = (proxyUrl: string, token: string): CallModel => async (req) => {
  const res = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ system: req.system, user: req.user, tools: req.tools }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`model-proxy ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as Awaited<ReturnType<CallModel>>;
};

const main = async (): Promise<number> => {
  const { command, pack: packArg } = parseArgs(process.argv.slice(2));
  if (command !== "heal") {
    console.error("usage: flare-agent heal --pack <incident-pack.json>");
    return 2;
  }

  const packPath = packArg ?? process.env.INCIDENT_PACK;
  if (packPath === undefined) {
    console.error("flare-agent: no --pack and no $INCIDENT_PACK");
    return 2;
  }
  const proxyUrl = process.env.FLARE_MODEL_PROXY;
  const token = process.env.FLARE_AGENT_TOKEN;
  if (proxyUrl === undefined || token === undefined) {
    console.error("flare-agent: $FLARE_MODEL_PROXY and $FLARE_AGENT_TOKEN are required");
    return 2;
  }

  const pack = JSON.parse(await readFile(resolve(packPath), "utf8")) as IncidentPack;

  const result = await runHeal({
    pack,
    io: {
      readFile: async (p) => {
        try {
          return await readFile(resolve(p), "utf8");
        } catch {
          return undefined;
        }
      },
      writeFile: async (p, content) => {
        // Defense in depth (runHeal already drops unsafe paths): confine every
        // write to the clone root (cwd) so an out-of-clone path can never land.
        const root = process.cwd();
        const target = resolve(root, p);
        if (!isSafeRepoPath(p) || (target !== root && !target.startsWith(root + sep))) {
          throw new Error(`refusing out-of-clone write: ${p}`);
        }
        await writeFile(target, content, "utf8");
      },
    },
    callModel: makeCallModel(proxyUrl, token),
  });

  const resultPath = resolve(dirname(resolve(packPath)), RESULT_FILE);
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  // Diagnostics to stderr; stdout stays clean (the run reads the result file).
  console.error(`flare-agent: ${result.outcome} (${result.changedFiles.length} files, ${result.tokensUsed} tokens)`);
  return 0;
};

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`flare-agent: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
