// Bundle the CLI into one ESM file and copy the built UI next to it.
import { build } from "esbuild";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..");
const dist = join(cli, "dist");
rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: [join(cli, "src/main.ts")],
  outfile: join(dist, "noodles.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // tree-sitter loads .wasm files relative to its package: keep it external.
  external: ["web-tree-sitter", "tree-sitter-wasms"],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "warning",
});

const ui = join(cli, "..", "ui", "dist");
if (existsSync(ui)) cpSync(ui, join(dist, "ui"), { recursive: true });
else console.warn("ui/dist not found: run `npm run build -w ui` first so `noodles serve` has a UI");
// The editor extension (unsaved edits for live mode), installed by `noodles editor install`.
const { buildVsix } = await import("../../scripts/vsix.mjs");
buildVsix(join(dist, "noodles-live.vsix"));
console.log("built cli/dist/noodles.mjs and cli/dist/noodles-live.vsix");
