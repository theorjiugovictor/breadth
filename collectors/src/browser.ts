// Browser-safe entry point: no Node APIs. Used by the in-browser repo scanner.
export { scanSources, parseSource, type SourceFile, type ScanOptions } from "./code/scan.js";
export { setWasmLocator, langForFile, GRAMMAR_FILES, type WasmLocator } from "./code/parser.js";
export { SERVICE_MANIFESTS } from "./code/build.js";
export { DEFAULT_EXCLUDES } from "./core/excludes.js";
export { TF_FILE, TFVARS_FILE } from "./infra/terraform-hcl.js";

import { mergeGraphs, SCHEMA_VERSION, type FlowGraph } from "@breadth/schema";
import { idPrefixFor, terraformGraph } from "./infra/terraform.js";
import { loadTerraform, type TfSourceFile } from "./infra/terraform-hcl.js";

/** Terraform / OpenTofu source already in memory (used by the browser scanner) as a flowgraph. */
export function scanTerraformSources(files: TfSourceFile[], rootName: string, warn?: (msg: string) => void): FlowGraph {
  const graphs: FlowGraph[] = loadTerraform(files, { warn }).map((root) => ({
    version: SCHEMA_VERSION,
    ...terraformGraph(root.resources, root.files[0], root.dir === "." ? rootName : root.dir, { idPrefix: idPrefixFor(root.dir), modules: root.modules }),
  }));
  return graphs.length ? mergeGraphs(...graphs) : { version: SCHEMA_VERSION, nodes: [], edges: [] };
}
