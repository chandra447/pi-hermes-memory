#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, "dist");

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: [join(root, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  minify: true,
  outdir,
  entryNames: "index",
  sourcemap: true,
  sourcesContent: true,
  legalComments: "none",
  logLevel: "info",
});
