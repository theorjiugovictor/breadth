import { promises as fs } from "node:fs";
import path from "node:path";
import { mergeGraphs, SCHEMA_VERSION, type FlowGraph } from "@breadth/schema";
import type { Collector, CollectorOptions } from "../core/types.js";
import { walkFiles } from "../core/walk.js";
import { k8sGraph, parseK8s, type K8sObject } from "./k8s.js";
import { applyPlan, idPrefixFor, linkIamToKubernetes, parseTerraform, terraformGraph } from "./terraform.js";
import { loadTerraform, TF_FILE, TFVARS_FILE, type TfSourceFile } from "./terraform-hcl.js";

export { applyPlan, parseTerraform, terraformGraph } from "./terraform.js";
export { loadTerraform, type TfRoot, type TfSourceFile } from "./terraform-hcl.js";

const CANDIDATE = /\.(json|tfstate|ya?ml|tf|tofu|tfvars)$/i;
/** Skip things that are certainly not infra descriptions. */
const NOT_INFRA = /(^|\/)(package(-lock)?\.json|tsconfig[\w.]*\.json|composer\.json|\.eslintrc\.json|flowgraph\.json|.*\.otlp\.json|pnpm-lock\.yaml|\.github\/.*|docker-compose\.ya?ml|mkdocs\.ya?ml|\.pre-commit-config\.yaml)$/;

async function candidates(target: string, options: CollectorOptions): Promise<{ root: string; files: string[] }> {
  const st = await fs.stat(target);
  if (st.isFile()) return { root: path.dirname(target), files: [path.basename(target)] };
  const files = await walkFiles(target, {
    exclude: options.exclude,
    include: options.include,
    filter: (f) => CANDIDATE.test(f) && !NOT_INFRA.test(f),
    maxFileBytes: 50_000_000,
  });
  return { root: target, files };
}

interface Found {
  /** Plan / state JSON. */
  terraform: { file: string; doc: Record<string, unknown> }[];
  /** .tf / .tofu / .tfvars source. */
  hcl: TfSourceFile[];
  k8s: K8sObject[];
}

async function scan(target: string, options: CollectorOptions): Promise<Found> {
  const { root, files } = await candidates(target, options);
  const found: Found = { terraform: [], hcl: [], k8s: [] };
  for (const rel of files) {
    let text: string;
    try {
      text = options.overlay?.get(path.join(root, rel)) ?? (await fs.readFile(path.join(root, rel), "utf8"));
    } catch {
      continue;
    }
    if (TF_FILE.test(rel) || TFVARS_FILE.test(rel)) {
      found.hcl.push({ path: rel, text });
    } else if (/\.tfvars$/i.test(rel)) {
      continue; // per-environment var files (prod.tfvars) apply only when passed with -var-file
    } else if (/\.(json|tfstate)$/i.test(rel)) {
      if (!/"(format_version|terraform_version)"/.test(text.slice(0, 5000))) continue;
      try {
        found.terraform.push({ file: rel, doc: JSON.parse(text) });
      } catch {
        options.log?.warn(`infra: could not parse ${rel}`);
      }
    } else if (/^\s*(apiVersion|kind):/m.test(text)) {
      found.k8s.push(...parseK8s(text, rel));
    }
  }
  return found;
}

export const infraCollector: Collector = {
  name: "infra",
  description: "Terraform/OpenTofu configuration (.tf), plan or state JSON, and Kubernetes manifests",
  implemented: true,

  async detect(target, options = {}) {
    try {
      const f = await scan(target, { exclude: options.exclude, include: options.include });
      return f.terraform.length > 0 || f.hcl.some((x) => TF_FILE.test(x.path)) || f.k8s.length > 0;
    } catch {
      return false;
    }
  },

  async collect(target, options = {}) {
    const found = await scan(target, options);
    const graphs: FlowGraph[] = [];
    const rootName = path.basename(path.resolve(target)).replace(/\.\w+$/, "") || "infra";
    const roots = loadTerraform(found.hcl, { warn: (m) => options.log?.warn(m) });
    for (const root of roots) {
      options.log?.info(`infra: ${root.dir === "." ? "" : `${root.dir}: `}${root.resources.length} terraform resources from ${root.files.length} .tf files`);
      const { nodes, edges } = terraformGraph(root.resources, root.files[0], root.dir === "." ? rootName : root.dir, { idPrefix: idPrefixFor(root.dir), modules: root.modules });
      graphs.push({ version: SCHEMA_VERSION, nodes, edges });
    }
    // A plan or state file for configuration that is also in the scan (a plan.json written next
    // to the .tf files, say) describes that configuration: it annotates it instead of repeating it.
    const plans: { dir: string; doc: Record<string, unknown> }[] = [];
    const rootAddresses = roots.map((r) => ({ dir: r.dir, addresses: new Set(r.resources.map((x) => x.address)) }));
    for (const { file, doc } of found.terraform) {
      const resources = parseTerraform(doc);
      if (!resources) continue;
      const strip = (a: string) => a.replace(/\[[^\]]*\]/g, "");
      const owner = rootAddresses
        .map((r) => ({ dir: r.dir, hits: resources.filter((x) => r.addresses.has(strip(x.address))).length }))
        .sort((a, b) => b.hits - a.hits)[0];
      if (owner && resources.length && owner.hits * 2 >= resources.length) {
        if (doc.resource_changes) plans.push({ dir: owner.dir, doc });
        continue;
      }
      options.log?.info(`infra: ${file}: ${resources.length} terraform resources`);
      const { nodes, edges } = terraformGraph(resources, file, rootName);
      graphs.push({ version: SCHEMA_VERSION, nodes, edges });
    }
    if (found.k8s.length) {
      options.log?.info(`infra: ${found.k8s.length} kubernetes objects`);
      const { nodes, edges } = k8sGraph(found.k8s);
      graphs.push({ version: SCHEMA_VERSION, nodes, edges });
    }
    const merged = graphs.length ? mergeGraphs(...graphs) : { version: SCHEMA_VERSION, nodes: [], edges: [] };
    linkIamToKubernetes(merged);
    for (const p of plans) options.log?.info(`infra: plan for ${p.dir}: ${applyPlan(merged, p.doc, p.dir)} resources change`);
    merged.sources = [{ collector: "infra", target: path.resolve(target), collectedAt: new Date().toISOString() }];
    return merged as FlowGraph;
  },
};
