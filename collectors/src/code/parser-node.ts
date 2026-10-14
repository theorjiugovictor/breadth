import { createRequire } from "node:module";
import path from "node:path";
import { setWasmLocator } from "./parser.js";

const require = createRequire(import.meta.url);

/** Node: grammars come from the tree-sitter-wasms package in node_modules. */
setWasmLocator({
  grammar(file) {
    const pkg = require.resolve("tree-sitter-wasms/package.json");
    return path.join(path.dirname(pkg), "out", file);
  },
});
