// @flare-dispatch/core — RunContext.
//
// The aggregate environment a run's Effect carries in its R channel: the union
// of every capability service. A runtime Layer (CFRuntimeLive / Dev / Test)
// provides all of them at once; a run never constructs it directly.
//
// Spec: specs/03-dsl.md § Layers.

import type { Artifact } from "./services/artifact";
import type { Browser } from "./services/browser";
import type { Cache } from "./services/cache";
import type { Config } from "./services/config";
import type { IO } from "./services/io";
import type { Sandbox } from "./services/sandbox";

/** The union of capability services every run Effect depends on. */
export type RunContext = Sandbox | Browser | Cache | Artifact | IO | Config;
