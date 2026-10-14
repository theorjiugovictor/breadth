// Builds the demo graphs with the bundled CLI:
//   examples/shop/flowgraph.json   code + infra + OpenTelemetry traces of the sample shop
//   examples/breadth.flowgraph.json   breadth scanning its own repository
//   examples/shop-pr.flowgraph.json   a pull request on the shop (examples/shop-pr), as a diff graph
//   examples/shop-pr.md                the PR comment breadth would post for it
// Run after `npm run build`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "cli/dist/breadth.mjs");
if (!existsSync(cli)) {
  console.error("cli/dist/breadth.mjs not found: run `npm run build` first");
  process.exit(1);
}
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, stdio: "inherit" });

run("scan", "examples/shop", "-o", "examples/shop/flowgraph.json");
run("import-traces", "examples/shop/traces/checkout.otlp.json", "--merge", "examples/shop/flowgraph.json");
run("scan", ".", "-o", "examples/breadth.flowgraph.json");
// The pull request demo: the shop before and after the files in examples/shop-pr.
const tmp = mkdtempSync(join(tmpdir(), "breadth-pr-"));
try {
  const head = join(tmp, "shop");
  cpSync(join(root, "examples/shop"), head, { recursive: true });
  cpSync(join(root, "examples/shop-pr/services"), join(head, "services"), { recursive: true });
  run("scan", "examples/shop", "-o", join(tmp, "before.json"), "-q");
  run("scan", head, "-o", join(tmp, "after.json"), "-q");
  run("diff", join(tmp, "before.json"), join(tmp, "after.json"), "--base", "main", "--head", "add-bulk-refunds", "-o", "examples/shop-pr.flowgraph.json", "--markdown", "examples/shop-pr.md");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log("\nDemo graphs ready:\n  breadth serve examples/shop/flowgraph.json\n  breadth serve examples/breadth.flowgraph.json\n  breadth serve examples/shop-pr.flowgraph.json");
