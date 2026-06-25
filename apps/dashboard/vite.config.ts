import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dashboard SPA build. Output goes to dist/, which the dispatcher Worker serves
// via the Workers Static Assets binding (root wrangler.jsonc → `assets`). The
// SPA reads its data from the same origin's Access-gated `/v1/dashboard.json`,
// so there is no API base URL to configure.
//
// `allowedHosts: [".ts.net"]` lets `tailscale serve` front `vite dev` / preview
// during local development (workspace convention).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { allowedHosts: [".ts.net"] },
  preview: { allowedHosts: [".ts.net"] },
});
