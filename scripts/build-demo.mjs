// Builds the demo graphs with the bundled CLI:
//   examples/shop/flowgraph.json   code + infra + OpenTelemetry traces of the sample shop
//   examples/noodles.flowgraph.json   noodles scanning its own repository
// Run after `npm run build`.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "cli/dist/noodles.mjs");
if (!existsSync(cli)) {
  console.error("cli/dist/noodles.mjs not found: run `npm run build` first");
  process.exit(1);
}
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, stdio: "inherit" });

run("scan", "examples/shop", "-o", "examples/shop/flowgraph.json");
run("import-traces", "examples/shop/traces/checkout.otlp.json", "--merge", "examples/shop/flowgraph.json");
run("scan", ".", "-o", "examples/noodles.flowgraph.json");
console.log("\nDemo graphs ready:\n  noodles serve examples/shop/flowgraph.json\n  noodles serve examples/noodles.flowgraph.json");
