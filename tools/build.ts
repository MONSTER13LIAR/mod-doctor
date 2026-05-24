#!/usr/bin/env -S node --experimental-strip-types

// Bundles sources to dist/ and public/.
//
// build.ts [--minify] [--watch]
// --local  Run development server. Serve on http://localhost:1234 and reload on
//          code change.
// --minify    Minify output.
// --watch     Automatically rebuild whenever an input changes.

import fs from "node:fs";
import type { BuildOptions } from "esbuild";
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

// Default Gemini key — baked in at build time so installs get zero-config AI.
// Set DR_MOD_DEFAULT_AI_KEY in the build environment to populate it; if empty,
// the runtime gracefully falls back to BYOK / heuristics-only.
const DEFAULT_AI_KEY = process.env.DR_MOD_DEFAULT_AI_KEY ?? "";
if (DEFAULT_AI_KEY) console.log(`[build] default AI key embedded (${DEFAULT_AI_KEY.length} chars).`);
else console.log("[build] no DR_MOD_DEFAULT_AI_KEY set — installs must use BYOK or heuristics-only.");

const opts: BuildOptions = {
  bundle: true,
  logLevel: "info", // Print the port and build demarcations.
  metafile: true,
  sourcemap: "linked",
  target: "es2023", // https://esbuild.github.io/content-types/#tsconfig-json
};

const clientOpts: BuildOptions = {
  ...opts,
  entryPoints: ["src/client/splash.ts", "src/client/heartbeat.ts"],
  format: "esm",
  outdir: "public",
  platform: "browser",
  splitting: true,
};
const serverOpts: BuildOptions = {
  ...opts,
  entryPoints: ["src/server/index.ts"],
  format: "cjs",
  outdir: "dist/server",
  platform: "node",
  define: {
    "process.env.DR_MOD_DEFAULT_AI_KEY": JSON.stringify(DEFAULT_AI_KEY),
  },
};

if (watch) {
  const clientCtx = await esbuild.context(clientOpts);
  const serverCtx = await esbuild.context(serverOpts);
  await Promise.all([
    watch ? clientCtx.watch() : undefined,
    watch ? serverCtx.watch() : undefined,
  ]);
} else {
  const [client, server] = await Promise.all([
    esbuild.build(clientOpts),
    esbuild.build(serverOpts),
  ]);
  if (client.metafile)
    fs.writeFileSync("dist/client.meta.json", JSON.stringify(client.metafile));
  if (server.metafile)
    fs.writeFileSync("dist/server.meta.json", JSON.stringify(server.metafile));
}
