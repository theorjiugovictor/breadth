import { edgeId, type EdgeKind, type FlowEdge, type FlowNode, type Layer, type NodeKind } from "@breadth/schema";

/** A resource normalised from state (show -json / raw tfstate), plan JSON or .tf source. */
export interface TfResource {
  address: string;
  type: string;
  name: string;
  module?: string;
  values: Record<string, unknown>;
  /** Addresses this resource refers to (dependencies / configuration references). */
  refs: Set<string>;
  /** Where it is declared (.tf source only). */
  file?: string;
  line?: number;
  /** What applying a plan does to it: create, update, delete or replace. */
  action?: PlanAction;
  /** Attributes that force a replacement. */
  reason?: string[];
}

export type PlanAction = "create" | "update" | "delete" | "replace";

type Json = Record<string, unknown>;

const DATASTORE = /^(aws_db_instance|aws_rds_cluster|aws_dynamodb_table|aws_s3_bucket|aws_elasticache_\w+|aws_docdb_cluster|aws_opensearch_domain|aws_elasticsearch_domain|aws_efs_file_system|google_sql_database_instance|google_storage_bucket|google_bigquery_dataset|google_redis_instance|azurerm_(postgresql|mysql|mssql|cosmosdb|redis)\w*|azurerm_storage_account)$/;
const QUEUE = /^(aws_sqs_queue|aws_sns_topic|aws_msk_cluster|aws_kinesis_stream|aws_mq_broker|aws_cloudwatch_event_bus|google_pubsub_topic|google_pubsub_subscription|azurerm_servicebus_\w+|azurerm_eventhub\w*)$/;
const ENDPOINT = /^(aws_lb|aws_alb|aws_elb|aws_lb_listener|aws_alb_listener|aws_lb_target_group|aws_alb_target_group|aws_api_gateway_rest_api|aws_apigatewayv2_api|aws_cloudfront_distribution|aws_route53_record|google_compute_forwarding_rule|azurerm_lb|azurerm_application_gateway)$/;
const SERVICE = /^(aws_ecs_service|aws_lambda_function|aws_apprunner_service|aws_instance|aws_autoscaling_group|aws_eks_node_group|google_cloud_run_service|google_cloud_run_v2_service|google_cloudfunctions\d?_function|google_compute_instance|azurerm_linux_web_app|azurerm_function_app|azurerm_container_app|kubernetes_deployment)$/;
const PIPELINE = /^(aws_codepipeline|aws_codebuild_project|google_cloudbuild_trigger|github_actions_\w+)$/;
const NETWORK = /^(aws_vpc|aws_subnet|aws_security_group|aws_security_group_rule|aws_vpc_security_group_\w+_rule|aws_route_table\w*|aws_internet_gateway|aws_nat_gateway|aws_network_acl\w*|aws_vpc_endpoint|aws_eip|google_compute_network|google_compute_subnetwork|google_compute_firewall|azurerm_virtual_network|azurerm_subnet|azurerm_network_security_group)$/;

function classify(type: string): { kind: NodeKind; layer: Layer } {
  if (DATASTORE.test(type)) return { kind: "datastore", layer: "infra" };
  if (QUEUE.test(type)) return { kind: "queue", layer: "messaging" };
  if (ENDPOINT.test(type)) return { kind: "network_endpoint", layer: "network" };
  if (SERVICE.test(type)) return { kind: "service", layer: "infra" };
  if (PIPELINE.test(type)) return { kind: "pipeline", layer: "delivery" };
  if (NETWORK.test(type)) return { kind: "infra_resource", layer: "network" };
  return { kind: "infra_resource", layer: "infra" };
}

const ENGINE_ALIAS: Record<string, string> = {
  postgres: "postgresql",
  "aurora-postgresql": "postgresql",
  mysql: "mysql",
  "aurora-mysql": "mysql",
  mariadb: "mysql",
  redis: "redis",
  memcached: "memcached",
};

/** Cross-layer identity: lets an RDS postgres merge with the code's `store:postgresql`, an ECS service with `service:x`. */
function aliasesFor(r: TfResource): string[] {
  const v = r.values;
  const out: string[] = [];
  const name = [v.name, v.function_name, v.identifier, v.cluster_name, v.bucket].find(isKnown);
  if (/^(aws_db_instance|aws_rds_cluster)$/.test(r.type) && isKnown(v.engine)) out.push(`datastore:${ENGINE_ALIAS[v.engine] ?? v.engine}`);
  if (/^aws_elasticache/.test(r.type) && isKnown(v.engine)) out.push(`datastore:${ENGINE_ALIAS[v.engine] ?? v.engine}`);
  if (r.type === "aws_msk_cluster") out.push("queue:kafka");
  // The cluster that runs the Kubernetes manifests (single-cluster setups).
  if (/^(aws_eks_cluster|google_container_cluster|azurerm_kubernetes_cluster)$/.test(r.type)) out.push("k8s:cluster");
  if (r.type === "aws_sqs_queue" && name) out.push(`topic:${name}`);
  if (r.type === "aws_sns_topic" && name) out.push(`topic:${name}`);
  if (SERVICE.test(r.type) && name && !/^(aws_instance|aws_autoscaling_group)$/.test(r.type)) out.push(`service:${name}`);
  return out;
}

/* ---------------- parsing ---------------- */

function collectModule(mod: Json | undefined, out: TfResource[], refsByAddress: Map<string, Set<string>>) {
  if (!mod) return;
  for (const r of (mod.resources as Json[] | undefined) ?? []) {
    if (r.mode === "data") continue;
    const address = String(r.address);
    out.push({
      address,
      type: String(r.type),
      name: String(r.name),
      module: moduleOf(address),
      values: (r.values as Json) ?? {},
      refs: new Set([...((r.depends_on as string[] | undefined) ?? []), ...(refsByAddress.get(address) ?? [])]),
    });
  }
  for (const c of (mod.child_modules as Json[] | undefined) ?? []) collectModule(c, out, refsByAddress);
}

function moduleOf(address: string): string | undefined {
  const m = address.match(/^((?:module\.[^.[]+(?:\[[^\]]+\])?\.)*)/);
  const prefix = m?.[1]?.replace(/\.$/, "");
  return prefix || undefined;
}

/** Walk plan `configuration` collecting `references` per resource address (expressions are nested arbitrarily). */
function configurationRefs(config: Json | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const walkModule = (mod: Json | undefined, prefix: string) => {
    if (!mod) return;
    for (const r of (mod.resources as Json[] | undefined) ?? []) {
      if (r.mode === "data") continue;
      const address = prefix + String(r.address);
      const refs = new Set<string>();
      const scan = (x: unknown) => {
        if (Array.isArray(x)) x.forEach(scan);
        else if (x && typeof x === "object") {
          for (const [k, v] of Object.entries(x)) {
            if (k === "references" && Array.isArray(v)) for (const ref of v) refs.add(prefix + String(ref));
            else scan(v);
          }
        }
      };
      scan(r.expressions);
      for (const d of (r.depends_on as string[] | undefined) ?? []) refs.add(prefix + d);
      out.set(address, refs);
    }
    for (const [name, call] of Object.entries((mod.module_calls as Record<string, Json> | undefined) ?? {})) {
      walkModule(call.module as Json, `${prefix}module.${name}.`);
    }
  };
  walkModule(config?.root_module as Json, "");
  return out;
}

/** Accepts `terraform show -json` (state or plan) and raw .tfstate (v4). Returns undefined if not Terraform. */
export function parseTerraform(doc: Json): TfResource[] | undefined {
  // raw tfstate
  if (typeof doc.version === "number" && Array.isArray(doc.resources) && "terraform_version" in doc) {
    const out: TfResource[] = [];
    for (const r of doc.resources as Json[]) {
      if (r.mode === "data") continue;
      const instances = (r.instances as Json[] | undefined) ?? [];
      instances.forEach((inst, i) => {
        const key = inst.index_key !== undefined ? `[${JSON.stringify(inst.index_key)}]` : instances.length > 1 ? `[${i}]` : "";
        const address = `${r.module ? `${r.module}.` : ""}${r.type}.${r.name}${key}`;
        out.push({
          address,
          type: String(r.type),
          name: String(r.name),
          module: r.module as string | undefined,
          values: (inst.attributes as Json) ?? {},
          refs: new Set(((inst.dependencies as string[] | undefined) ?? []).map(String)),
        });
      });
    }
    return out;
  }
  if (!("format_version" in doc)) return undefined;
  const refs = configurationRefs(doc.configuration as Json);
  const out: TfResource[] = [];
  const values = (doc.planned_values ?? doc.values) as Json | undefined;
  collectModule(values?.root_module as Json, out, refs);
  const changes = planChanges(doc);
  for (const r of out) Object.assign(r, changes.get(r.address));
  // Resources only in resource_changes (e.g. being deleted) still matter for the picture.
  if (doc.resource_changes) {
    const seen = new Set(out.map((r) => r.address));
    for (const rc of doc.resource_changes as Json[]) {
      const address = String(rc.address);
      if (seen.has(address) || rc.mode === "data") continue;
      const change = rc.change as Json;
      out.push({
        address,
        type: String(rc.type),
        name: String(rc.name),
        module: rc.module_address as string | undefined,
        values: ((change?.after ?? change?.before) as Json) ?? {},
        refs: refs.get(address) ?? new Set(),
        ...changes.get(address),
      });
    }
  }
  return out;
}

/** Plan `resource_changes`: what applying does to each address. No-ops are left out. */
export function planChanges(doc: Json): Map<string, { action: PlanAction; reason?: string[] }> {
  const out = new Map<string, { action: PlanAction; reason?: string[] }>();
  for (const rc of (doc.resource_changes as Json[] | undefined) ?? []) {
    if (rc.mode === "data") continue;
    const change = (rc.change as Json) ?? {};
    const actions = ((change.actions as string[] | undefined) ?? []).join(",");
    const action: PlanAction | undefined =
      actions === "create" ? "create" : actions === "update" ? "update" : actions === "delete" ? "delete" : actions.includes("delete") && actions.includes("create") ? "replace" : undefined;
    if (!action) continue;
    const paths = (change.replace_paths as unknown[][] | undefined) ?? [];
    const reason = [...new Set(paths.map((p) => String(p[0])).filter(Boolean))];
    out.set(String(rc.address), { action, reason: reason.length ? reason : undefined });
  }
  return out;
}

/** Instance keys removed: module.db[0].aws_db_instance.main["a"] -> module.db.aws_db_instance.main */
const withoutKeys = (address: string) => address.replace(/\[[^\]]*\]/g, "");

/**
 * Mark the Terraform nodes of a graph with what a plan does to them (metadata.plan_action).
 * `dir` is the root module the plan was made for, relative to the scanned folder.
 * Returns how many nodes matched.
 */
export function applyPlan(graph: { nodes: FlowNode[] }, plan: Json, dir?: string): number {
  const changes = new Map<string, { action: PlanAction; reason?: string[] }>();
  for (const [address, c] of planChanges(plan)) {
    const key = withoutKeys(address);
    // Several instances (count / for_each): the most drastic action wins.
    const prev = changes.get(key);
    if (!prev || ACTION_RANK[c.action] > ACTION_RANK[prev.action]) changes.set(key, c);
  }
  // No folder given: the root module whose resources the plan matches best.
  if (dir === undefined) {
    const score = new Map<string, number>();
    for (const n of graph.nodes) {
      const ref = n.source?.resource_ref;
      if (n.metadata?.platform !== "terraform" || !ref || !n.id.endsWith(ref) || !changes.has(withoutKeys(ref))) continue;
      const p = n.id.slice(3, n.id.length - ref.length);
      score.set(p, (score.get(p) ?? 0) + 1);
    }
    dir = [...score].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  }
  const prefix = idPrefixFor(dir);
  let matched = 0;
  for (const n of graph.nodes) {
    const ref = n.source?.resource_ref;
    if (n.metadata?.platform !== "terraform" || !ref || n.id !== `tf:${prefix}${ref}`) continue;
    const c = changes.get(withoutKeys(ref));
    if (!c) continue;
    n.metadata = compact({ ...n.metadata, plan_action: c.action, plan_reason: c.reason });
    matched++;
  }
  return matched;
}

const ACTION_RANK: Record<PlanAction, number> = { create: 0, update: 1, delete: 2, replace: 3 };

/** Node ids of a root module in a subfolder carry its path: tf:envs/prod/aws_db_instance.main. */
export function idPrefixFor(dir: string): string {
  return !dir || dir === "." ? "" : `${dir.replace(/\/+$/, "")}/`;
}

/* ---------------- graph ---------------- */

export interface Built {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface GraphOptions {
  /** Prepended to every resource id (root modules in subfolders): "envs/prod/". */
  idPrefix?: string;
  /** Module calls, so that registry modules (whose resources are not visible) still get a node. */
  modules?: { address: string; source: string; file?: string; line?: number }[];
  /** Emit cross-layer aliases (datastore:postgresql, service:x). Off for non-primary root modules. */
  aliases?: boolean;
}

/** "${aws_vpc.main.id}" (a reference kept by the .tf reader) -> "aws_vpc.main.id". */
export function markerRef(s: string): string | undefined {
  return s.match(/\$\{([^}?]+)\}/)?.[1];
}

const isKnown = (v: unknown): v is string => typeof v === "string" && !v.includes("${");

export function terraformGraph(resources: TfResource[], sourceFile: string, rootName: string, opts: GraphOptions = {}): Built {
  const prefix = opts.idPrefix ?? "";
  const nodes = new Map<string, FlowNode>();
  const edges = new Map<string, FlowEdge>();
  const rootId = `tf:root:${rootName}`;
  nodes.set(rootId, { id: rootId, name: `terraform: ${rootName}`, kind: "system", layer: "infra", description: "Terraform / OpenTofu configuration", source: { file: sourceFile } });

  const byAddress = new Map(resources.map((r) => [r.address, r]));
  const addresses = [...byAddress.keys()].sort((a, b) => b.length - a.length);
  /** 'aws_vpc.main.id' or '${aws_vpc.main.id}' -> 'aws_vpc.main' (longest known prefix). */
  const resolveRef = (raw: string): string | undefined => {
    const ref = markerRef(raw) ?? raw;
    if (byAddress.has(ref)) return ref;
    const clean = ref.replace(/\[[^\]]*\]$/, "");
    if (byAddress.has(clean)) return clean;
    return addresses.find((a) => ref.startsWith(`${a}.`) || ref.startsWith(`${a}[`) || clean === a.replace(/\[[^\]]*\]$/, "")) ?? resolveRefs(ref)[0];
  };
  // aws_sqs_queue.jobs["a"], aws_sqs_queue.jobs["b"]: a reference to aws_sqs_queue.jobs (no key, or [*]) means all of them.
  const instancesOf = new Map<string, string[]>();
  for (const a of byAddress.keys()) {
    const m = a.match(/^(.*)\[[^\]]*\]$/);
    if (m) instancesOf.set(m[1], [...(instancesOf.get(m[1]) ?? []), a]);
  }
  const bases = [...instancesOf.keys()].sort((a, b) => b.length - a.length);
  function resolveRefs(raw: string): string[] {
    const ref = markerRef(raw) ?? raw;
    const base = bases.find((b) => ref === b || ref.startsWith(`${b}.`) || ref.startsWith(`${b}[`));
    if (!base) return [];
    const exact = instancesOf.get(base)!.find((a) => ref === a || ref.startsWith(`${a}.`) || ref.startsWith(`${a}[`));
    return exact ? [exact] : instancesOf.get(base)!;
  }

  const moduleInfo = new Map((opts.modules ?? []).map((m) => [m.address, m]));
  const ensureModule = (mod: string): string => {
    const id = `tf:${prefix}${mod}`;
    if (!nodes.has(id)) {
      const parentMod = moduleOf(mod.replace(/\.?module\.[^.[]+(\[[^\]]+\])?$/, "") + ".x");
      const parent = parentMod ? ensureModule(parentMod) : rootId;
      const info = moduleInfo.get(mod);
      nodes.set(id, {
        id,
        name: mod.split(".").pop()!,
        kind: "module",
        layer: "infra",
        parent,
        description: `Terraform module ${mod}${info?.source ? ` (${info.source})` : ""}`,
        source: compact({ resource_ref: mod, file: info?.file, line: info?.line }) as FlowNode["source"],
        metadata: info ? compact({ platform: "terraform", module_source: info.source }) : undefined,
      });
    }
    return id;
  };
  for (const m of opts.modules ?? []) ensureModule(m.address);

  const idOf = (address: string) => `tf:${prefix}${address}`;
  /** Firewall rules are drawn as network edges, not as nodes. */
  const isRule = (type: string) => /(_security_group_rule|_security_group_(ingress|egress)_rule|_network_acl_rule|^azurerm_network_security_rule)$/.test(type);

  // ids (sg-123, arn:...) and names -> address, to resolve values that point at other resources
  const byConcreteId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const r of resources) {
    for (const k of ["id", "arn"]) {
      const val = r.values[k];
      if (isKnown(val) && val.length > 3) byConcreteId.set(val, r.address);
    }
    for (const k of ["name", "bucket", "function_name", "identifier", "role"]) {
      const val = r.values[k];
      if (isKnown(val) && !byName.has(`${r.type}:${val}`)) byName.set(`${r.type}:${val}`, r.address);
    }
  }
  /** A value that names another resource: a reference marker, an id/ARN from state, or a name. */
  const resolveValue = (v: unknown, type?: RegExp): string | undefined => {
    if (typeof v !== "string") return undefined;
    const ref = markerRef(v);
    const a = ref ? resolveRef(ref) : (byConcreteId.get(v) ?? resources.find((r) => (!type || type.test(r.type)) && byName.get(`${r.type}:${v}`) === r.address)?.address);
    return a && (!type || type.test(byAddress.get(a)!.type)) ? a : undefined;
  };

  const posture = computePosture(resources, resolveValue);

  for (const r of resources) {
    if (isRule(r.type)) continue;
    const { kind, layer } = classify(r.type);
    const v = r.values;
    const display = [v.name, v.function_name, v.identifier, v.bucket, v.cluster_name].find(isKnown);
    const tags = knownTags(v.tags);
    const p = posture.get(r.address);
    nodes.set(idOf(r.address), {
      id: idOf(r.address),
      name: display && display.length < 60 ? display : `${r.type}.${r.name}`,
      description: tags.Name && tags.Name !== display ? tags.Name : undefined,
      kind,
      layer,
      parent: r.module ? ensureModule(r.module) : rootId,
      aliases: opts.aliases !== false && aliasesFor(r).length ? aliasesFor(r) : undefined,
      source: compact({ resource_ref: r.address, file: r.file ?? sourceFile, line: r.line }) as FlowNode["source"],
      tags: Object.keys(tags).length ? Object.entries(tags).map(([k, val]) => `${k}=${val}`) : undefined,
      metadata: compact({
        platform: "terraform",
        type: r.type,
        engine: isKnown(v.engine) ? v.engine : undefined,
        region: [v.region, v.availability_zone, v.location].find(isKnown),
        arn: isKnown(v.arn) ? v.arn : undefined,
        id: isKnown(v.id) ? v.id : undefined,
        public: p?.public ? true : undefined,
        public_reason: p?.public,
        encrypted: p?.encrypted,
        settings: settingsOf(v),
        plan_action: r.action,
        plan_reason: r.reason,
        aws_ref: awsRef(r),
      }),
    });
  }

  // Environment variables of Lambda functions and ECS tasks: values, and the resources they name.
  const envOf = (r: TfResource): Record<string, unknown> | undefined => {
    if (r.type === "aws_lambda_function") return ((r.values.environment as Json[] | undefined)?.[0]?.variables as Json | undefined) ?? undefined;
    if (r.type === "aws_ecs_task_definition" && typeof r.values.container_definitions === "string") {
      try {
        const defs = JSON.parse(r.values.container_definitions) as Json[];
        return Object.fromEntries(defs.flatMap((d) => ((d.environment as Json[] | undefined) ?? []).map((e) => [String(e.name), e.value])));
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  for (const r of resources) {
    const vars = envOf(r);
    if (!vars) continue;
    const env: Record<string, string> = {};
    const envRefs: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) {
      if (isKnown(v)) env[k] = v;
      else if (typeof v === "string" && markerRef(v)) {
        const a = resolveRef(v);
        if (a && nodes.has(idOf(a))) envRefs[k] = idOf(a);
      }
    }
    // An ECS service runs its task definition's environment.
    const holders = r.type === "aws_ecs_task_definition" ? [r.address, ...resources.filter((x) => x.type === "aws_ecs_service" && resolveValue(x.values.task_definition) === r.address).map((x) => x.address)] : [r.address];
    for (const h of holders) {
      const n = nodes.get(idOf(h));
      if (n) n.metadata = compact({ ...n.metadata, env: Object.keys(env).length ? env : undefined, env_refs: Object.keys(envRefs).length ? envRefs : undefined });
    }
  }

  const addEdge = (kind: EdgeKind, from: string, to: string, extra: Partial<FlowEdge> = {}) => {
    if (from === to) return;
    const id = edgeId(kind, { node: from }, { node: to });
    if (!edges.has(id)) edges.set(id, { id, from: { node: from }, to: { node: to }, kind, ...extra });
  };

  const sgUsers = new Map<string, Set<string>>(); // sg address -> resource addresses using it
  for (const r of resources) {
    if (isRule(r.type)) continue;
    const refs = new Set<string>();
    for (const ref of r.refs) {
      const multi = resolveRefs(ref);
      const a = multi.length > 1 ? multi[0] : resolveRef(ref);
      for (const x of multi.length > 1 ? multi : a ? [a] : []) if (x !== r.address) refs.add(x);
      // module outputs (module.network.vpc_id): depend on the module as a whole
      const mod = !a ? ref.match(/^((?:module\.[^.[]+(?:\[[^\]]*\])?\.)*module\.[^.[]+)/)?.[1] : undefined;
      if (mod && nodes.has(`tf:${prefix}${mod}`) && !(r.module ?? "").startsWith(mod)) addEdge("depends_on", idOf(r.address), `tf:${prefix}${mod}`);
    }
    // Concrete ids in attribute values (state files).
    scanStrings(r.values, (s) => {
      const a = byConcreteId.get(s);
      if (a && a !== r.address) refs.add(a);
    });
    for (const a of refs) {
      const target = byAddress.get(a)!;
      if (isRule(target.type)) continue;
      if (target.type === "aws_security_group" && !/security_group/.test(r.type)) {
        if (!sgUsers.has(a)) sgUsers.set(a, new Set());
        sgUsers.get(a)!.add(r.address);
      }
      // Traffic-carrying references become network edges in the direction traffic flows.
      if (/^aws_(lb|alb)_listener$/.test(r.type) && /^aws_(lb|alb)$/.test(target.type)) addEdge("network", idOf(a), idOf(r.address), { protocol: lower(r.values.protocol), label: portLabel(r.values.port, r.values.protocol) });
      else if (/^aws_(lb|alb)_listener$/.test(r.type) && /target_group$/.test(target.type)) addEdge("network", idOf(r.address), idOf(a), { protocol: lower(r.values.protocol) });
      else if (/target_group$/.test(target.type) && (r.type === "aws_ecs_service" || r.type === "aws_lb_target_group_attachment" || r.type === "aws_autoscaling_attachment")) addEdge("network", idOf(a), idOf(r.address), { protocol: lower(target.values.protocol), label: portLabel(target.values.port, target.values.protocol) });
      else if (r.type === "aws_lambda_event_source_mapping") addEdge("event", idOf(a), idOf(r.address), { protocol: target.type.replace(/^aws_/, "") });
      else addEdge("depends_on", idOf(r.address), idOf(a));
    }
  }

  // Firewall rules -> network edges between the workloads behind each group.
  const rules: { from?: string; to: string; label?: string; protocol?: string; cidr?: string }[] = [];
  const sg = (v: unknown) => resolveValue(v, /^aws_security_group$/);
  for (const r of resources) {
    const v = r.values;
    if (r.type === "aws_security_group") {
      for (const ing of (v.ingress as Json[] | undefined) ?? []) {
        const label = portLabel(ing.from_port, ing.protocol, ing.to_port);
        for (const s of (ing.security_groups as string[] | undefined) ?? []) {
          const src = sg(s);
          if (src) rules.push({ from: src, to: r.address, label, protocol: lower(ing.protocol) });
        }
        for (const c of cidrs(ing.cidr_blocks, ing.ipv6_cidr_blocks)) rules.push({ to: r.address, label, cidr: c, protocol: lower(ing.protocol) });
      }
    }
    if (r.type === "aws_security_group_rule" || r.type === "aws_vpc_security_group_ingress_rule") {
      if (v.type && v.type !== "ingress") continue;
      const refs = [...r.refs].map(resolveRef).filter(Boolean) as string[];
      const to = sg(v.security_group_id) ?? refs.find((a) => byAddress.get(a)?.type === "aws_security_group");
      const from = sg(v.source_security_group_id ?? v.referenced_security_group_id) ?? refs.filter((a) => byAddress.get(a)?.type === "aws_security_group" && a !== to)[0];
      if (!to) continue;
      const protocol = lower(v.protocol ?? v.ip_protocol);
      const label = portLabel(v.from_port, v.protocol ?? v.ip_protocol, v.to_port);
      if (from) rules.push({ from, to, label, protocol });
      for (const c of cidrs(v.cidr_blocks, v.ipv6_cidr_blocks, v.cidr_ipv4, v.cidr_ipv6)) rules.push({ to, label, cidr: c, protocol });
    }
    // GCP: ingress firewall rules apply to instances with the target tags (or all of the network).
    if (r.type === "google_compute_firewall" && (v.direction ?? "INGRESS") === "INGRESS") {
      const allows = (v.allow as Json[] | undefined) ?? [];
      const label = allows.map((a) => portLabel((a.ports as unknown[] | undefined)?.join(","), a.protocol)).filter(Boolean).join(", ") || undefined;
      const targetTags = (v.target_tags as string[] | undefined) ?? [];
      const net = resolveValue(v.network);
      const targets = resources.filter((x) => x.type === "google_compute_instance" && (targetTags.length ? ((x.values.tags as string[] | undefined) ?? []).some((t) => targetTags.includes(t)) : !net || resolveValue(firstNetwork(x)) === net)).map((x) => x.address);
      for (const c of cidrs(v.source_ranges)) for (const t of targets.length ? targets : [r.address]) rules.push({ to: t, label, cidr: c });
    }
    // Azure: inbound allow rules of a network security group.
    const azureRules = r.type === "azurerm_network_security_group" ? ((v.security_rule as Json[] | undefined) ?? []).map((x) => ({ rule: x, nsg: r.address })) : r.type === "azurerm_network_security_rule" ? [{ rule: v, nsg: resolveValue(v.network_security_group_name, /^azurerm_network_security_group$/) }] : [];
    for (const { rule, nsg } of azureRules) {
      if (!nsg || String(rule.direction).toLowerCase() !== "inbound" || String(rule.access).toLowerCase() !== "allow") continue;
      const src = [rule.source_address_prefix, ...((rule.source_address_prefixes as unknown[] | undefined) ?? [])].filter(isKnown).map((s) => (s === "*" || /^internet$/i.test(s) ? "0.0.0.0/0" : s));
      const ports = [rule.destination_port_range, ...((rule.destination_port_ranges as unknown[] | undefined) ?? [])].filter(isKnown).map((p) => (p === "*" ? "all ports" : p));
      const label = `${lower(rule.protocol) === "*" ? "" : `${lower(rule.protocol) ?? ""}/`}${ports.join(",")}`.replace(/^\//, "") || undefined;
      for (const c of src) if (/\//.test(c) || c === "0.0.0.0/0") rules.push({ to: nsg, label, cidr: c });
    }
  }
  for (const rule of rules) {
    const targets = [...(sgUsers.get(rule.to) ?? [rule.to])];
    const sources = rule.from ? [...(sgUsers.get(rule.from) ?? [rule.from])] : [];
    if (rule.cidr) {
      const net = rule.cidr === "0.0.0.0/0" || rule.cidr === "::/0" ? "internet" : rule.cidr;
      const netId = `net:${net}`;
      if (!nodes.has(netId)) nodes.set(netId, { id: netId, name: net === "internet" ? "Internet" : net, kind: "network_endpoint", layer: "network", description: net === "internet" ? "Any address" : `CIDR ${net}`, metadata: { cidr: rule.cidr } });
      sources.push(netId);
    }
    for (const s of sources) {
      for (const t of targets) {
        if (!nodes.has(idOf(t))) continue;
        const from = s.startsWith("net:") ? s : idOf(s);
        addEdge("network", from, idOf(t), { protocol: rule.protocol === "-1" ? undefined : rule.protocol, label: rule.label });
      }
    }
  }

  iamEdges(resources, { resolveValue, resolveRef, byAddress, idOf, nodes, edges });

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** "s3:shop-receipts": how code names the resource (see code/cloud.ts), to match the two. */
const AWS_REF: Record<string, [string, string]> = {
  aws_s3_bucket: ["s3", "bucket"],
  aws_dynamodb_table: ["dynamodb", "name"],
  aws_sqs_queue: ["sqs", "name"],
  aws_sns_topic: ["sns", "name"],
  aws_secretsmanager_secret: ["secretsmanager", "name"],
  aws_lambda_function: ["lambda", "function_name"],
  aws_kinesis_stream: ["kinesis", "name"],
};

function awsRef(r: TfResource): string | undefined {
  const m = AWS_REF[r.type];
  const name = m && r.values[m[1]];
  return m && isKnown(name) ? `${m[0]}:${name}` : undefined;
}

/* ---------------- IAM: who may read or write what ---------------- */

interface Statement {
  effect: string;
  actions: string[];
  notAction: boolean;
  resources: string[];
  principals: string[];
  conditional: boolean;
}

/** Statements of an IAM policy, given as a JSON string (state, plan, rendered by the .tf reader) or an object. */
export function policyStatements(policy: unknown): Statement[] {
  let doc = policy;
  if (typeof doc === "string") {
    try {
      doc = JSON.parse(doc);
    } catch {
      return [];
    }
  }
  if (!doc || typeof doc !== "object") return [];
  const st = (doc as Json).Statement;
  const list = (Array.isArray(st) ? st : st ? [st] : []) as Json[];
  const strings = (x: unknown) => (Array.isArray(x) ? x : x === undefined ? [] : [x]).filter((s): s is string => typeof s === "string");
  return list.map((s) => ({
    effect: String(s.Effect ?? "Allow"),
    actions: strings(s.Action ?? s.NotAction),
    notAction: s.Action === undefined && s.NotAction !== undefined,
    resources: strings(s.Resource ?? (s.NotResource !== undefined ? "*" : undefined)),
    principals: s.Principal === "*" ? ["*"] : s.Principal && typeof s.Principal === "object" ? Object.values(s.Principal as Json).flatMap(strings) : [],
    conditional: !!s.Condition,
  }));
}

/** AWS managed policies that matter for review: what they grant, roughly. */
function managedPolicy(arn: string): Statement[] {
  const name = arn.match(/^arn:aws[\w-]*:iam::aws:policy\/(?:.*\/)?([\w+=,.@-]+)$/)?.[1];
  if (!name) return [];
  const st = (actions: string[]): Statement[] => [{ effect: "Allow", actions, notAction: false, resources: ["*"], principals: [], conditional: false }];
  if (name === "AdministratorAccess") return st(["*"]);
  if (name === "PowerUserAccess") return [{ effect: "Allow", actions: ["iam:*", "organizations:*"], notAction: true, resources: ["*"], principals: [], conditional: false }];
  const full = name.match(/^Amazon(\w+?)FullAccess$/)?.[1];
  if (full) return st([`${full.replace(/^Elastic/, "").toLowerCase()}:*`]);
  return [];
}

const READ = /^(Get|List|Query|Scan|Receive|Read|Select|BatchGet|Head|Search|Download|Consume|Subscribe|Decrypt|Lookup|Retrieve|Fetch|Export)/;
const WRITE = /^(Put|Delete|Update|Create|Send|Publish|Write|BatchWrite|Upload|Restore|Modify|Set|Change|Purge|Insert|Execute|Encrypt|Abort|Copy|Replace|Remove|Add|Tag|Untag|Start|Stop|Rotate|Import)/;

function accessOf(action: string): { read: boolean; write: boolean; invoke: boolean } {
  const verb = action.includes(":") ? action.slice(action.indexOf(":") + 1) : action;
  if (verb === "*" || action === "*") return { read: true, write: true, invoke: true };
  const v = verb.replace(/\*$/, "");
  const prefixMatch = (re: RegExp) => re.test(verb) || (verb.endsWith("*") && re.source.slice(2, -1).split("|").some((w) => w.startsWith(v)));
  return { read: prefixMatch(READ), write: prefixMatch(WRITE), invoke: /^Invoke/.test(verb) || (verb.endsWith("*") && "Invoke".startsWith(v)) };
}

/** Keys on a workload that name the IAM role it runs as. */
const ROLE_KEYS = ["role", "role_arn", "task_role_arn", "service_role", "instance_role_arn", "iam_role_arn", "service_role_arn"];

interface IamCtx {
  resolveValue(v: unknown, type?: RegExp): string | undefined;
  resolveRef(r: string): string | undefined;
  byAddress: Map<string, TfResource>;
  idOf(address: string): string;
  nodes: Map<string, FlowNode>;
  edges: Map<string, FlowEdge>;
}

function iamEdges(resources: TfResource[], ctx: IamCtx) {
  const ROLE = /^aws_iam_role$/;
  const policies = new Map<string, Statement[]>(); // aws_iam_policy address -> statements
  for (const r of resources) if (r.type === "aws_iam_policy") policies.set(r.address, policyStatements(r.values.policy));
  const attached = (arn: unknown): Statement[] => {
    const a = ctx.resolveValue(arn, /^aws_iam_policy$/);
    if (a) return policies.get(a) ?? [];
    return typeof arn === "string" ? managedPolicy(arn) : [];
  };

  // role address -> statements granted to it
  const grants = new Map<string, Statement[]>();
  const grant = (role: string | undefined, st: Statement[]) => {
    if (!role || !st.length) return;
    grants.set(role, [...(grants.get(role) ?? []), ...st]);
  };
  for (const r of resources) {
    const v = r.values;
    if (r.type === "aws_iam_role") {
      for (const p of (v.inline_policy as Json[] | undefined) ?? []) grant(r.address, policyStatements(p.policy));
      for (const arn of (v.managed_policy_arns as unknown[] | undefined) ?? []) grant(r.address, attached(arn));
    } else if (r.type === "aws_iam_role_policy") grant(ctx.resolveValue(v.role, ROLE), policyStatements(v.policy));
    else if (r.type === "aws_iam_role_policy_attachment") grant(ctx.resolveValue(v.role, ROLE), attached(v.policy_arn));
    else if (r.type === "aws_iam_policy_attachment" || r.type === "aws_iam_role_policies_exclusive") {
      for (const role of (v.roles as unknown[] | undefined) ?? []) grant(ctx.resolveValue(role, ROLE), attached(v.policy_arn));
    }
  }
  if (!grants.size) return;

  // role -> the workloads that run as it
  const users = new Map<string, Set<string>>();
  const use = (role: string | undefined, workload: string) => {
    if (!role) return;
    if (!users.has(role)) users.set(role, new Set());
    users.get(role)!.add(workload);
  };
  const profiles = new Map<string, string>(); // instance profile -> role
  for (const r of resources) {
    if (r.type === "aws_iam_instance_profile") {
      const role = ctx.resolveValue(r.values.role, ROLE);
      if (role) profiles.set(r.address, role);
    }
  }
  for (const r of resources) {
    // IAM plumbing and pod identity associations name a role without running as it.
    if (/^aws_iam_|^aws_eks_pod_identity_association$|^aws_eks_cluster$|^aws_eks_node_group$/.test(r.type)) continue;
    const v = r.values;
    const nested = [v, ...Object.values(v).flatMap((x) => (Array.isArray(x) ? x.filter((y) => y && typeof y === "object") : []))] as Json[];
    for (const o of nested) {
      for (const k of ROLE_KEYS) {
        // ECS: the execution role only pulls images and secrets for the agent, not the app.
        if (r.type === "aws_ecs_task_definition" && k !== "task_role_arn") continue;
        use(ctx.resolveValue(o[k], ROLE), r.address);
      }
      const profile = ctx.resolveValue(o.iam_instance_profile, /^aws_iam_instance_profile$/);
      if (profile) use(profiles.get(profile), r.address);
    }
  }
  // An ECS service runs its task definition's role.
  for (const r of resources) {
    if (r.type !== "aws_ecs_service") continue;
    const td = ctx.resolveValue(r.values.task_definition, /^aws_ecs_task_definition$/);
    for (const set of users.values()) if (td && set.has(td)) set.add(r.address);
  }
  // Kubernetes workloads (EKS pod identity / IRSA): named on the role.
  const serviceAccounts = new Map<string, string[]>();
  for (const r of resources) {
    if (r.type === "aws_eks_pod_identity_association") {
      const role = ctx.resolveValue(r.values.role_arn, ROLE);
      if (role && isKnown(r.values.service_account)) serviceAccounts.set(role, [...(serviceAccounts.get(role) ?? []), `${isKnown(r.values.namespace) ? `${r.values.namespace}/` : ""}${r.values.service_account}`]);
    }
    if (r.type === "aws_iam_role" && typeof r.values.assume_role_policy === "string") {
      for (const m of r.values.assume_role_policy.matchAll(/system:serviceaccount:([\w-]+):([\w-]+)/g)) serviceAccounts.set(r.address, [...(serviceAccounts.get(r.address) ?? []), `${m[1]}/${m[2]}`]);
    }
  }

  const access = new Map<string, { kind: EdgeKind; from: string; to: string; actions: Set<string>; role: string }>();
  for (const [role, statements] of grants) {
    const roleNode = ctx.nodes.get(ctx.idOf(role));
    if (!roleNode) continue;
    // Workloads that run as the role (an ECS service rather than its task definition when both exist).
    let workloads = [...(users.get(role) ?? [])];
    const services = workloads.filter((w) => ctx.byAddress.get(w)?.type === "aws_ecs_service");
    if (services.length) workloads = workloads.filter((w) => ctx.byAddress.get(w)?.type !== "aws_ecs_task_definition");
    const subjects = workloads.length ? workloads : [role];
    const broad = new Set<string>();
    for (const st of statements) {
      if (st.effect !== "Allow") continue;
      const anyResource = st.resources.includes("*");
      if (st.notAction) broad.add(`everything except ${st.actions.join(", ")} on ${anyResource ? "*" : "some resources"}`);
      else if (st.actions.includes("*")) broad.add(`* on ${anyResource ? "*" : "some resources"}`);
      else for (const a of st.actions) if (/:\*$/.test(a) && anyResource) broad.add(`${a} on *`);
      if (st.notAction) continue;
      for (const res of st.resources) {
        if (res === "*") continue;
        const target = resolveArn(res, ctx);
        if (!target || target === role) continue;
        const targetNode = ctx.nodes.get(ctx.idOf(target));
        if (!targetNode) continue;
        for (const action of st.actions) {
          const { read, write, invoke } = accessOf(action);
          for (const w of subjects) {
            const wid = ctx.idOf(w);
            const tid = ctx.idOf(target);
            const add = (kind: EdgeKind, from: string, to: string) => {
              const key = `${kind}|${from}|${to}`;
              if (!access.has(key)) access.set(key, { kind, from, to, actions: new Set(), role });
              access.get(key)!.actions.add(action);
            };
            const queue = targetNode.kind === "queue";
            if (write) add(queue ? "event" : "write", wid, tid);
            if (read) add(queue ? "event" : "read", tid, wid);
            if (invoke && !write && !read) add("call", wid, tid);
          }
        }
      }
    }
    for (const w of workloads) {
      const wn = ctx.nodes.get(ctx.idOf(w));
      if (wn) wn.metadata = { ...wn.metadata, iam_roles: [...new Set([...((wn.metadata?.iam_roles as string[] | undefined) ?? []), roleNode.id])] };
    }
    roleNode.metadata = compact({
      ...roleNode.metadata,
      iam_broad: broad.size ? [...broad].sort() : undefined,
      used_by: workloads.length ? workloads.map((w) => ctx.nodes.get(ctx.idOf(w))?.name ?? w).sort() : undefined,
      k8s_service_accounts: serviceAccounts.get(role),
    });
  }
  for (const a of access.values()) {
    const id = edgeId(a.kind, { node: a.from }, { node: a.to });
    if (ctx.edges.has(id)) continue;
    const actions = [...a.actions].sort();
    ctx.edges.set(id, {
      id,
      from: { node: a.from },
      to: { node: a.to },
      kind: a.kind,
      label: actions.length > 3 ? `${actions.slice(0, 3).join(", ")}, …` : actions.join(", "),
      metadata: { via: "iam", role: a.role, actions },
    });
  }
}

/**
 * After Kubernetes manifests are merged in: IAM access granted to a role that pods assume
 * (EKS Pod Identity / IRSA) is drawn from the workloads running as that service account.
 */
export function linkIamToKubernetes(graph: { nodes: FlowNode[]; edges: FlowEdge[] }): void {
  const bySa = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.metadata?.platform !== "kubernetes" || n.kind !== "service") continue;
    const key = `${n.metadata.namespace ?? "default"}/${n.metadata.serviceAccount ?? "default"}`;
    bySa.set(key, [...(bySa.get(key) ?? []), n.id]);
  }
  const workloads = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const sas = n.metadata?.k8s_service_accounts as string[] | undefined;
    const ids = (sas ?? []).flatMap((sa) => bySa.get(sa) ?? []);
    if (ids.length) workloads.set(n.id, ids);
  }
  if (!workloads.size) return;
  const out = new Map<string, FlowEdge>();
  for (const e of graph.edges) {
    const fromW = e.metadata?.via === "iam" ? workloads.get(e.from.node) : undefined;
    const toW = e.metadata?.via === "iam" ? workloads.get(e.to.node) : undefined;
    if (!fromW && !toW) {
      out.set(e.id, e);
      continue;
    }
    for (const from of fromW ?? [e.from.node]) {
      for (const to of toW ?? [e.to.node]) {
        const id = edgeId(e.kind, { node: from }, { node: to });
        if (!out.has(id)) out.set(id, { ...e, id, from: { node: from }, to: { node: to } });
      }
    }
  }
  graph.edges = [...out.values()];
  for (const n of graph.nodes) {
    const ids = workloads.get(n.id);
    if (!ids) continue;
    n.metadata = { ...n.metadata, used_by: ids.map((id) => graph.nodes.find((x) => x.id === id)?.name ?? id).sort() };
    for (const w of graph.nodes.filter((x) => ids.includes(x.id))) w.metadata = { ...w.metadata, iam_roles: [...new Set([...((w.metadata?.iam_roles as string[] | undefined) ?? []), n.id])] };
  }
}

/** A policy Resource ("${aws_s3_bucket.x.arn}/*", "arn:aws:s3:::bucket/*") -> the resource it names. */
function resolveArn(res: string, ctx: IamCtx): string | undefined {
  const ref = markerRef(res);
  if (ref) return ctx.resolveRef(ref);
  const direct = ctx.resolveValue(res);
  if (direct) return direct;
  // Strip object paths and wildcards: arn:aws:s3:::bucket/* -> arn:aws:s3:::bucket
  for (const cut of [res.replace(/\/.*$/, ""), res.replace(/:\*$/, ""), res.replace(/[:/][^:/]*\*.*$/, "")]) {
    const a = ctx.resolveValue(cut);
    if (a) return a;
  }
  // arn:aws:s3:::name with no ARN in state: match by bucket name
  const bucket = res.match(/^arn:aws[\w-]*:s3:::([^/*]+)/)?.[1];
  return bucket ? ctx.resolveValue(bucket, /^aws_s3_bucket$/) : undefined;
}

/* ---------------- security posture ---------------- */

const ENCRYPTION: Record<string, string> = {
  aws_db_instance: "storage_encrypted",
  aws_rds_cluster: "storage_encrypted",
  aws_docdb_cluster: "storage_encrypted",
  aws_neptune_cluster: "storage_encrypted",
  aws_ebs_volume: "encrypted",
  aws_efs_file_system: "encrypted",
  aws_redshift_cluster: "encrypted",
  aws_elasticache_replication_group: "at_rest_encryption_enabled",
};

/** Whether data stores are public or unencrypted, from their own settings and the resources aimed at them. */
function computePosture(resources: TfResource[], resolveValue: (v: unknown, type?: RegExp) => string | undefined): Map<string, { public?: string; encrypted?: boolean }> {
  const out = new Map<string, { public?: string; encrypted?: boolean }>();
  const set = (a: string | undefined, p: { public?: string; encrypted?: boolean }) => {
    if (a) out.set(a, { ...out.get(a), ...p });
  };
  const BUCKET = /^aws_s3_bucket$/;
  const blocked = new Map<string, { acls: boolean; policy: boolean }>();
  for (const r of resources) {
    if (r.type !== "aws_s3_bucket_public_access_block") continue;
    const v = r.values;
    blocked.set(resolveValue(v.bucket, BUCKET) ?? "", { acls: v.block_public_acls === true && v.ignore_public_acls === true, policy: v.block_public_policy === true && v.restrict_public_buckets === true });
  }
  for (const r of resources) {
    const v = r.values;
    const key = ENCRYPTION[r.type];
    if (key) {
      const inherits = isKnown(v.replicate_source_db) || (r.type === "aws_db_instance" && isKnown(v.engine) && /^aurora/.test(v.engine)) || isKnown(v.snapshot_identifier);
      // Unset means the provider default, which is unencrypted for these types. Unknown stays unknown.
      const val = v[key];
      if (!inherits && (val === true || val === false || val === undefined)) set(r.address, { encrypted: val === true });
    }
    if (r.type === "aws_opensearch_domain" || r.type === "aws_elasticsearch_domain") {
      const ear = (v.encrypt_at_rest as Json[] | undefined)?.[0];
      if (!ear || ear.enabled === true || ear.enabled === false) set(r.address, { encrypted: ear?.enabled === true });
    }
    if ((r.type === "aws_db_instance" || r.type === "aws_rds_cluster_instance") && v.publicly_accessible === true) set(r.address, { public: "publicly_accessible = true" });
    if (r.type === "aws_s3_bucket" && isKnown(v.acl) && /^public-/.test(v.acl) && !blocked.get(r.address)?.acls) set(r.address, { public: `acl = "${v.acl}"` });
    if (r.type === "aws_s3_bucket_acl" && isKnown(v.acl) && /^public-/.test(v.acl)) {
      const b = resolveValue(v.bucket, BUCKET);
      if (b && !blocked.get(b)?.acls) set(b, { public: `acl = "${v.acl}"` });
    }
    if (r.type === "aws_s3_bucket_policy") {
      const b = resolveValue(v.bucket, BUCKET);
      const open = policyStatements(v.policy).some((s) => s.effect === "Allow" && s.principals.includes("*") && !s.conditional);
      if (b && open && !blocked.get(b)?.policy) set(b, { public: "bucket policy allows anyone" });
    }
    if (/^google_storage_bucket_iam_(member|binding)$/.test(r.type)) {
      const members = [v.member, ...((v.members as unknown[] | undefined) ?? [])];
      const who = members.find((m) => m === "allUsers" || m === "allAuthenticatedUsers");
      const b = resolveValue(v.bucket, /^google_storage_bucket$/);
      if (b && who) set(b, { public: `${who} can access it` });
    }
    if (r.type === "azurerm_storage_container" && isKnown(v.container_access_type) && v.container_access_type !== "private") {
      const acct = resolveValue(v.storage_account_name ?? v.storage_account_id, /^azurerm_storage_account$/);
      set(acct, { public: `container ${isKnown(v.name) ? v.name : ""} is ${v.container_access_type}`.replace("  ", " ") });
    }
  }
  return out;
}

/** Settings whose change is worth a reviewer's attention (size, availability, safety nets). */
const SETTINGS = ["engine", "instance_class", "instance_type", "instance_types", "node_type", "engine_version", "version", "allocated_storage", "multi_az", "memory_size", "timeout", "runtime", "desired_count", "cpu", "memory", "min_size", "max_size", "deletion_protection", "backup_retention_period", "skip_final_snapshot", "publicly_accessible", "number_of_broker_nodes", "billing_mode"];

function settingsOf(v: Json): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const k of SETTINGS) {
    const x = v[k];
    if (x === undefined || x === null || (typeof x === "string" && !isKnown(x))) continue;
    if (typeof x === "object" && !Array.isArray(x)) continue;
    if (Array.isArray(x) && !x.every((y) => typeof y !== "object" && isKnown(String(y)))) continue;
    out[k] = x;
  }
  return Object.keys(out).length ? out : undefined;
}

function knownTags(tags: unknown): Record<string, string> {
  if (!tags || typeof tags !== "object") return {};
  return Object.fromEntries(Object.entries(tags as Json).filter((e): e is [string, string] => isKnown(e[1])));
}

function firstNetwork(r: TfResource): unknown {
  return ((r.values.network_interface as Json[] | undefined) ?? [])[0]?.network;
}

function cidrs(...xs: unknown[]): string[] {
  return xs.flatMap((x) => (Array.isArray(x) ? x : x === undefined ? [] : [x])).filter(isKnown);
}

function scanStrings(x: unknown, fn: (s: string) => void, depth = 0) {
  if (depth > 6) return;
  if (typeof x === "string") fn(x);
  else if (Array.isArray(x)) x.forEach((v) => scanStrings(v, fn, depth + 1));
  else if (x && typeof x === "object") for (const v of Object.values(x)) scanStrings(v, fn, depth + 1);
}

function lower(v: unknown): string | undefined {
  return isKnown(v) && v ? v.toLowerCase() : undefined;
}

function portLabel(from: unknown, protocol: unknown, to?: unknown): string | undefined {
  const p = isKnown(protocol) && protocol !== "-1" ? protocol.toLowerCase() : protocol === "-1" || protocol === -1 ? "all" : undefined;
  if (from === undefined || from === null || (typeof from === "string" && !isKnown(from)) || from === "") return p;
  const range = to !== undefined && to !== from && isKnown(String(to)) ? `${from}-${to}` : String(from);
  if (Number(from) === 0 && (Number(to) === 0 || Number(to) === 65535)) return p === "all" ? "all traffic" : `${p ?? ""} all ports`.trim();
  return p ? `${p}/${range}` : range;
}

function compact(o: Record<string, unknown>) {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === "") delete o[k];
  return o;
}
