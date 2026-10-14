// Copies tree-sitter's runtime and the grammars into public/wasm so the browser scanner can load them.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "wasm");
mkdirSync(out, { recursive: true });
const runtime = require.resolve("web-tree-sitter/tree-sitter.wasm");
copyFileSync(runtime, join(out, "tree-sitter.wasm"));
const grammars = join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
for (const g of ["python", "typescript", "tsx", "javascript"]) copyFileSync(join(grammars, `tree-sitter-${g}.wasm`), join(out, `tree-sitter-${g}.wasm`));
console.log("copied tree-sitter wasm files to public/wasm");
