// Builds the static GitHub Pages site into site-dist/:
//   /           landing page (site/)
//   /app/       the canvas UI, with bundled demo graphs in /app/graphs/
// Run after `npm run build && npm run demo:build`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "site-dist");

execFileSync("npm", ["run", "build:pages", "-w", "ui"], { cwd: root, stdio: "inherit" });
cpSync(join(root, "site"), out, { recursive: true });

const demos = [
  { from: "examples/shop-pr.flowgraph.json", file: "shop-pr.json", title: "Pull request: add bulk refunds", description: "What an agent-written PR on the shop changes in behaviour" },
  { from: "examples/shop/flowgraph.json", file: "shop.json", title: "Shop: code, infra and traces", description: "Four services, Postgres, Kafka, Terraform, Kubernetes and two recorded checkouts" },
  { from: "examples/breadth.flowgraph.json", file: "breadth.json", title: "breadth: this repository", description: "breadth scanning its own source code" },
];
const graphs = join(out, "app", "graphs");
mkdirSync(graphs, { recursive: true });
const index = [];
for (const d of demos) {
  const src = join(root, d.from);
  if (!existsSync(src)) {
    console.warn(`missing ${d.from}: run \`npm run demo:build\` first`);
    continue;
  }
  cpSync(src, join(graphs, d.file));
  index.push({ file: d.file, title: d.title, description: d.description });
}
writeFileSync(join(graphs, "index.json"), JSON.stringify(index, null, 2));
writeFileSync(join(out, ".nojekyll"), "");
console.log(`site built in ${out}`);
