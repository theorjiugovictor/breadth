import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { edgeId, SCHEMA_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from "@breadth/schema";
import type { Collector, CollectorOptions } from "../core/types.js";
import { walkFiles } from "../core/walk.js";

/**
 * How code becomes running software: GitHub Actions workflows and GitLab CI pipelines, their
 * jobs, what triggers them, what they build and what they deploy where. Deploy targets are
 * found in run scripts (kubectl, helm, terraform, aws lambda/ecs, gcloud run, argocd) and
 * become nodes aliased like the services, Kubernetes workloads and Terraform roots other
 * collectors emit, so they merge with them.
 */

type Json = Record<string, any>;

interface Job {
  id: string;
  name: string;
  needs: string[];
  scripts: string[];
  uses: string[];
  env: Json;
  /** with: of each `uses` step, for actions that deploy or push images */
  withs: Json[];
  line?: number;
}

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const GITLAB = /(^|\/)\.gitlab-ci\.ya?ml$/;

/** Deploy commands in a run script -> alias of the thing deployed, and a label. */
export function deployTargets(script: string): { alias: string; name: string; label: string }[] {
  const out: { alias: string; name: string; label: string }[] = [];
  const s = script.replace(/\\\n/g, " ");
  const add = (alias: string, name: string, label: string) => {
    if (!out.some((o) => o.alias === alias)) out.push({ alias, name, label });
  };
  for (const m of s.matchAll(/kubectl\b[^\n;&|]*?\b(?:set image|rollout restart|rollout status|scale)\s+(?:deployment|deploy|statefulset|sts|daemonset|ds)[/ ]([\w.-]+)/g)) add(`service:${m[1]}`, m[1], "kubectl");
  for (const m of s.matchAll(/helm\s+(?:upgrade\s+(?:--install\s+|-i\s+)?|install\s+)(?:--?[\w-]+(?:[ =][^\s-][^\s]*)?\s+)*([\w.-]+)/g)) add(`service:${m[1]}`, m[1], "helm");
  for (const m of s.matchAll(/terraform\s+(?:-chdir=(\S+)\s+)?apply\b/g)) {
    // the folder: -chdir=, else the last `cd` before it (working-directory is turned into one)
    const cd = [...s.slice(0, m.index).matchAll(/(?:^|[\n;&]\s*)cd\s+([^\s;&]+)/g)].pop()?.[1];
    const dir = (m[1] ?? cd ?? ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";
    add(`tfroot:${dir}`, dir === "." ? "terraform" : dir, "terraform apply");
  }
  for (const m of s.matchAll(/aws\s+lambda\s+update-function-(?:code|configuration)\b[^\n]*?--function-name[ =]([\w-]+)/g)) add(`service:${m[1]}`, m[1], "aws lambda");
  for (const m of s.matchAll(/aws\s+ecs\s+update-service\b[^\n]*?--service[ =]([\w-]+)/g)) add(`service:${m[1]}`, m[1], "aws ecs");
  for (const m of s.matchAll(/gcloud\s+run\s+deploy\s+([\w-]+)/g)) add(`service:${m[1]}`, m[1], "gcloud run");
  for (const m of s.matchAll(/argocd\s+app\s+sync\s+([\w-]+)/g)) add(`service:${m[1]}`, m[1], "argocd");
  return out;
}

/** Images a script or a docker/build-push-action step builds: ghcr.io/acme/orders:1.2 -> ghcr.io/acme/orders. */
export function builtImages(script: string, withs: Json[] = []): string[] {
  const out = new Set<string>();
  for (const m of script.matchAll(/docker\s+(?:buildx\s+)?build\b[^\n]*?(?:-t|--tag)[ =]([^\s]+)/g)) out.add(m[1]);
  for (const w of withs) if (w?.tags && w.push !== false) for (const t of String(w.tags).split(/[\n,]/)) if (t.trim()) out.add(t.trim());
  return [...out].map((i) => i.replace(/:[^/:]*$/, "")).filter((i) => !i.includes("${") && !/^\$/.test(i));
}

function githubJobs(doc: Json): Job[] {
  return Object.entries((doc.jobs ?? {}) as Json).map(([id, j]) => {
    const steps = (Array.isArray(j?.steps) ? j.steps : []) as Json[];
    return {
      id,
      name: String(j?.name ?? id),
      needs: Array.isArray(j?.needs) ? j.needs.map(String) : j?.needs ? [String(j.needs)] : [],
      // working-directory (the step's, else the job's default) becomes a leading `cd`
      scripts: steps
        .filter((s) => typeof s?.run === "string")
        .map((s) => {
          const wd = s["working-directory"] ?? j?.defaults?.run?.["working-directory"];
          return `${typeof wd === "string" ? `cd ${wd}\n` : ""}${s.run}`;
        }),
      uses: [...steps.map((s) => s?.uses).filter((u): u is string => typeof u === "string"), ...(typeof j?.uses === "string" ? [j.uses] : [])],
      withs: steps.filter((s) => typeof s?.uses === "string").map((s) => s.with ?? {}),
      env: { ...(j?.env ?? {}) },
    };
  });
}

const GITLAB_RESERVED = new Set(["stages", "variables", "include", "default", "workflow", "image", "services", "before_script", "after_script", "cache", "pages"]);

function gitlabJobs(doc: Json): Job[] {
  const jobs: Job[] = [];
  const stages = Array.isArray(doc.stages) ? doc.stages.map(String) : ["build", "test", "deploy"];
  for (const [id, j] of Object.entries(doc)) {
    if (GITLAB_RESERVED.has(id) || id.startsWith(".") || !j || typeof j !== "object" || Array.isArray(j)) continue;
    const lines = (x: unknown) => (Array.isArray(x) ? x.map(String) : typeof x === "string" ? [x] : []);
    jobs.push({
      id,
      name: id,
      needs: Array.isArray(j.needs) ? j.needs.map((n: any) => String(n?.job ?? n)) : [],
      scripts: [...lines(j.before_script), ...lines(j.script), ...lines(j.after_script)].map((l) => l),
      uses: [],
      withs: [],
      env: { ...(j.variables ?? {}), stage: j.stage ?? "test" },
    });
  }
  // Without needs:, a job waits for every job of the previous stage.
  for (const job of jobs) {
    if (job.needs.length) continue;
    const i = stages.indexOf(String(job.env.stage));
    if (i > 0) job.needs = jobs.filter((x) => String(x.env.stage) === stages[i - 1]).map((x) => x.id);
  }
  return jobs;
}

function triggers(doc: Json): { on: string[]; paths: string[] } {
  const on = doc.on ?? doc.true; // YAML 1.1 reads a bare `on:` key as true
  const names = typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : on && typeof on === "object" ? Object.keys(on) : [];
  const paths = new Set<string>();
  if (on && typeof on === "object" && !Array.isArray(on)) for (const t of Object.values(on as Json)) for (const p of (t as Json)?.paths ?? []) paths.add(String(p));
  return { on: names, paths: [...paths] };
}

/** ${{ secrets.NAME }} references: names only, never values. */
function secretNames(text: string): string[] {
  return [...new Set([...text.matchAll(/secrets\.([A-Za-z_][\w]*)/g)].map((m) => m[1]))].filter((n) => n !== "GITHUB_TOKEN").sort();
}

/** rootName: what the infra collector calls a Terraform root module at the top of the scan. */
export function cicdGraph(files: { path: string; text: string }[], rootName = "."): FlowGraph {
  const nodes = new Map<string, FlowNode>();
  const edges = new Map<string, FlowEdge>();
  const addEdge = (kind: FlowEdge["kind"], from: string, to: string, extra: Partial<FlowEdge> = {}) => {
    const id = edgeId(kind, { node: from }, { node: to });
    if (!edges.has(id)) edges.set(id, { id, from: { node: from }, to: { node: to }, kind, ...extra });
  };
  for (const f of files) {
    let doc: Json;
    try {
      doc = parseYaml(f.text) as Json;
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object") continue;
    const provider = GITLAB.test(f.path) ? "gitlab" : "github";
    const jobs = provider === "github" ? githubJobs(doc) : gitlabJobs(doc);
    if (!jobs.length) continue;
    const wid = `ci:${provider}:${f.path}`;
    const t = provider === "github" ? triggers(doc) : { on: ["push", "merge_request"], paths: [] };
    const lineOf = (key: string) => {
      const i = f.text.search(new RegExp(`^\\s{0,4}${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m"));
      return i < 0 ? undefined : f.text.slice(0, i).split("\n").length;
    };
    nodes.set(wid, {
      id: wid,
      name: String(doc.name ?? path.posix.basename(f.path)),
      kind: "pipeline",
      layer: "delivery",
      description: `${provider === "github" ? "GitHub Actions workflow" : "GitLab CI pipeline"}${t.on.length ? ` on ${t.on.join(", ")}` : ""}`,
      inputs: t.on.map((name) => ({ name, type: "trigger" })),
      source: { file: f.path },
      metadata: compact({ platform: provider === "github" ? "github-actions" : "gitlab-ci", paths: t.paths.length ? t.paths : undefined, permissions: doc.permissions }),
    });
    // Code folders the workflow watches.
    for (const p of t.paths) {
      const dir = p.replace(/\/?\*\*.*$/, "").replace(/\/\*.*$/, "");
      if (!dir || /[*!{]/.test(dir)) continue;
      const id = `ci:path:${dir}`;
      if (!nodes.has(id)) nodes.set(id, { id, name: `${dir}/`, kind: "module", layer: "code", aliases: [`code:dir:${dir}`], metadata: { placeholder: true } });
      addEdge("depends_on", wid, id, { label: "triggered by changes in" });
    }
    for (const j of jobs) {
      const jid = `${wid}#${j.id}`;
      const script = j.scripts.join("\n");
      const jobText = JSON.stringify(doc.jobs?.[j.id] ?? doc[j.id] ?? {});
      const images = builtImages(script, j.withs);
      nodes.set(jid, {
        id: jid,
        name: j.name,
        kind: "pipeline",
        layer: "delivery",
        parent: wid,
        source: { file: f.path, line: lineOf(j.id) },
        outputs: images.length ? images.map((i) => ({ name: i, type: "image" })) : undefined,
        metadata: compact({
          platform: provider === "github" ? "github-actions" : "gitlab-ci",
          uses: j.uses.length ? j.uses : undefined,
          secrets: secretNames(jobText).length ? secretNames(jobText) : undefined,
          permissions: (doc.jobs?.[j.id] as Json | undefined)?.permissions,
          checkout_ref: j.withs.map((w) => w?.ref).find((r) => typeof r === "string"),
        }),
      });
      for (const n of j.needs) addEdge("depends_on", jid, `${wid}#${n}`, { label: "needs" });
      for (const img of images) {
        const id = `image:${img}`;
        if (!nodes.has(id)) nodes.set(id, { id, name: img, kind: "infra_resource", layer: "delivery", description: "Container image", metadata: { type: "container_image" } });
        addEdge("data", jid, id, { label: "builds" });
      }
      const targets = [...deployTargets(script)];
      // Deploying actions: aws-actions/amazon-ecs-deploy-task-definition, google-github-actions/deploy-cloudrun, ...
      j.uses.forEach((u, i) => {
        const w = j.withs[i] ?? {};
        if (/deploy-cloudrun/.test(u) && w.service) targets.push({ alias: `service:${w.service}`, name: String(w.service), label: "deploy-cloudrun" });
        if (/amazon-ecs-deploy-task-definition/.test(u) && w.service) targets.push({ alias: `service:${w.service}`, name: String(w.service), label: "ecs deploy" });
        if (/(setup-)?terraform/.test(u) && /terraform\s+apply/.test(script)) {
          /* covered by the run script */
        }
      });
      for (const tg of targets) {
        // A node aliased like what other collectors emit: it merges into the real service / root.
        const id = `deploy:${tg.alias}`;
        if (!nodes.has(id)) {
          const dir = tg.alias.slice(7);
          const alias = tg.alias.startsWith("tfroot:") ? `tf:root:${dir === "." ? rootName : dir}` : tg.alias;
          nodes.set(id, { id, name: tg.name, kind: tg.alias.startsWith("tfroot:") ? "system" : "service", layer: "infra", aliases: [alias], description: "Deployed by CI", metadata: { placeholder: true } });
        }
        addEdge("deploy", jid, id, { label: tg.label });
      }
    }
  }
  return { version: SCHEMA_VERSION, nodes: [...nodes.values()], edges: [...edges.values()] };
}

async function files(target: string, options: CollectorOptions): Promise<{ path: string; text: string }[]> {
  const st = await fs.stat(target);
  const root = st.isFile() ? path.dirname(target) : target;
  // .github is excluded from generic walks; look for workflows explicitly.
  const list = st.isFile()
    ? [path.basename(target)]
    : [
        ...(await walkFiles(path.join(root, ".github", "workflows"), { filter: (f) => /\.ya?ml$/.test(f) }).catch(() => [] as string[])).map((f) => `.github/workflows/${f}`),
        ...(await walkFiles(root, { exclude: options.exclude, include: options.include, filter: (f) => GITLAB.test(f) })),
      ];
  const out: { path: string; text: string }[] = [];
  for (const rel of list) {
    if (!WORKFLOW.test(rel) && !GITLAB.test(rel)) continue;
    try {
      out.push({ path: rel, text: options.overlay?.get(path.join(root, rel)) ?? (await fs.readFile(path.join(root, rel), "utf8")) });
    } catch {
      /* unreadable */
    }
  }
  return out;
}

export const cicdCollector: Collector = {
  name: "cicd",
  description: "GitHub Actions workflows and GitLab CI: jobs, triggers, images built, what is deployed where",
  implemented: true,
  async detect(target, options = {}) {
    try {
      return (await files(target, options)).length > 0;
    } catch {
      return false;
    }
  },
  async collect(target, options = {}) {
    const g = cicdGraph(await files(target, options), path.basename(path.resolve(target)).replace(/\.\w+$/, "") || "infra");
    options.log?.info(`cicd: ${g.nodes.filter((n) => n.kind === "pipeline" && !n.parent).length} pipelines, ${g.edges.filter((e) => e.kind === "deploy").length} deploy targets`);
    // Placeholders that nothing else claims are dropped after merging (see registry).
    g.sources = [{ collector: "cicd", target: path.resolve(target), collectedAt: new Date().toISOString() }];
    return g;
  },
};

function compact(o: Record<string, unknown>) {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === "") delete o[k];
  return o;
}
