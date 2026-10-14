import { edgeId, type EdgeKind, type FlowEdge, type FlowNode, type Layer, type NodeKind } from "@noodles/schema";

/** A resource normalised from state (show -json / raw tfstate) or plan JSON. */
interface TfResource {
  address: string;
  type: string;
  name: string;
  module?: string;
  values: Record<string, unknown>;
  /** Addresses this resource refers to (dependencies / configuration references). */
  refs: Set<string>;
}

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
  const name = (v.name ?? v.function_name ?? v.identifier ?? v.cluster_name ?? v.bucket) as string | undefined;
  if (/^(aws_db_instance|aws_rds_cluster)$/.test(r.type) && typeof v.engine === "string") out.push(`datastore:${ENGINE_ALIAS[v.engine] ?? v.engine}`);
  if (/^aws_elasticache/.test(r.type) && typeof v.engine === "string") out.push(`datastore:${ENGINE_ALIAS[v.engine] ?? v.engine}`);
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
      });
    }
  }
  return out;
}

/* ---------------- graph ---------------- */

export interface Built {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export function terraformGraph(resources: TfResource[], sourceFile: string, rootName: string): Built {
  const nodes = new Map<string, FlowNode>();
  const edges = new Map<string, FlowEdge>();
  const rootId = `tf:root:${rootName}`;
  nodes.set(rootId, { id: rootId, name: `terraform: ${rootName}`, kind: "system", layer: "infra", description: "Terraform / OpenTofu configuration", source: { file: sourceFile } });

  const byAddress = new Map(resources.map((r) => [r.address, r]));
  const addresses = [...byAddress.keys()].sort((a, b) => b.length - a.length);
  /** 'aws_vpc.main.id' -> 'aws_vpc.main' (longest known prefix). */
  const resolveRef = (ref: string): string | undefined => {
    if (byAddress.has(ref)) return ref;
    const clean = ref.replace(/\[[^\]]*\]$/, "");
    if (byAddress.has(clean)) return clean;
    return addresses.find((a) => ref.startsWith(`${a}.`) || ref.startsWith(`${a}[`) || clean === a.replace(/\[[^\]]*\]$/, ""));
  };

  const ensureModule = (mod: string): string => {
    const id = `tf:${mod}`;
    if (!nodes.has(id)) {
      const parentMod = moduleOf(mod.replace(/\.?module\.[^.[]+(\[[^\]]+\])?$/, "") + ".x");
      const parent = parentMod ? ensureModule(parentMod) : rootId;
      nodes.set(id, { id, name: mod.split(".").pop()!, kind: "module", layer: "infra", parent, description: `Terraform module ${mod}`, source: { resource_ref: mod } });
    }
    return id;
  };

  const idOf = (address: string) => `tf:${address}`;
  /** Firewall rules are drawn as network edges, not as nodes. */
  const isRule = (type: string) => /(_security_group_rule|_security_group_(ingress|egress)_rule|_network_acl_rule)$/.test(type);
  for (const r of resources) {
    if (isRule(r.type)) continue;
    const { kind, layer } = classify(r.type);
    const v = r.values;
    const display = (v.name ?? v.function_name ?? v.identifier ?? v.bucket ?? v.cluster_name) as string | undefined;
    const tags = (v.tags as Record<string, string> | undefined) ?? {};
    nodes.set(idOf(r.address), {
      id: idOf(r.address),
      name: typeof display === "string" && display.length < 60 ? display : `${r.type}.${r.name}`,
      description: tags.Name && tags.Name !== display ? tags.Name : undefined,
      kind,
      layer,
      parent: r.module ? ensureModule(r.module) : rootId,
      aliases: aliasesFor(r).length ? aliasesFor(r) : undefined,
      source: { resource_ref: r.address, file: sourceFile },
      tags: Object.keys(tags).length ? Object.entries(tags).map(([k, val]) => `${k}=${val}`) : undefined,
      metadata: compact({ platform: "terraform", type: r.type, engine: v.engine, region: v.region ?? v.availability_zone, arn: v.arn, id: v.id }),
    });
  }

  const addEdge = (kind: EdgeKind, from: string, to: string, extra: Partial<FlowEdge> = {}) => {
    if (from === to) return;
    const id = edgeId(kind, { node: from }, { node: to });
    if (!edges.has(id)) edges.set(id, { id, from: { node: from }, to: { node: to }, kind, ...extra });
  };

  // ids (sg-123, arn:...) -> address, to resolve references stored as concrete values in state
  const byConcreteId = new Map<string, string>();
  for (const r of resources) {
    for (const k of ["id", "arn"]) {
      const val = r.values[k];
      if (typeof val === "string" && val.length > 3) byConcreteId.set(val, r.address);
    }
  }

  const sgUsers = new Map<string, Set<string>>(); // sg address -> resource addresses using it
  for (const r of resources) {
    if (isRule(r.type)) continue;
    const refs = new Set<string>();
    for (const ref of r.refs) {
      const a = resolveRef(ref);
      if (a && a !== r.address) refs.add(a);
      // module outputs (module.network.vpc_id): depend on the module as a whole
      const mod = !a ? ref.match(/^(module\.[^.[]+)/)?.[1] : undefined;
      if (mod && nodes.has(`tf:${mod}`) && !(r.module ?? "").startsWith(mod)) addEdge("depends_on", idOf(r.address), `tf:${mod}`);
    }
    // Concrete ids in attribute values (state files).
    scanStrings(r.values, (s) => {
      const a = byConcreteId.get(s);
      if (a && a !== r.address) refs.add(a);
    });
    for (const a of refs) {
      const target = byAddress.get(a)!;
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

  // Security group rules -> network edges between the workloads behind each group.
  const rules: { from?: string; to: string; label?: string; protocol?: string; cidr?: string }[] = [];
  for (const r of resources) {
    if (r.type === "aws_security_group") {
      for (const ing of (r.values.ingress as Json[] | undefined) ?? []) {
        const srcs = ((ing.security_groups as string[] | undefined) ?? []).map((s) => byConcreteId.get(s) ?? resolveRef(s)).filter(Boolean) as string[];
        const label = portLabel(ing.from_port, ing.protocol, ing.to_port);
        for (const s of srcs) rules.push({ from: s, to: r.address, label, protocol: lower(ing.protocol) });
        for (const c of (ing.cidr_blocks as string[] | undefined) ?? []) rules.push({ to: r.address, label, cidr: c, protocol: lower(ing.protocol) });
      }
    }
    if (r.type === "aws_security_group_rule" || r.type === "aws_vpc_security_group_ingress_rule") {
      if (r.values.type && r.values.type !== "ingress") continue;
      const refs = [...r.refs].map(resolveRef).filter(Boolean) as string[];
      const sgId = (r.values.security_group_id as string | undefined) ?? undefined;
      const srcId = (r.values.source_security_group_id ?? r.values.referenced_security_group_id) as string | undefined;
      const to = (sgId && byConcreteId.get(sgId)) || refs.find((a) => byAddress.get(a)?.type === "aws_security_group");
      const from = (srcId && byConcreteId.get(srcId)) || refs.filter((a) => byAddress.get(a)?.type === "aws_security_group" && a !== to)[0];
      if (!to) continue;
      const label = portLabel(r.values.from_port, r.values.protocol ?? r.values.ip_protocol, r.values.to_port);
      if (from) rules.push({ from, to, label, protocol: lower(r.values.protocol ?? r.values.ip_protocol) });
      for (const c of ((r.values.cidr_blocks as string[] | undefined) ?? (r.values.cidr_ipv4 ? [r.values.cidr_ipv4 as string] : []))) rules.push({ to, label, cidr: c });
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
        const from = s.startsWith("net:") ? s : idOf(s);
        addEdge("network", from, idOf(t), { protocol: rule.protocol === "-1" ? undefined : rule.protocol, label: rule.label });
      }
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function scanStrings(x: unknown, fn: (s: string) => void, depth = 0) {
  if (depth > 6) return;
  if (typeof x === "string") fn(x);
  else if (Array.isArray(x)) x.forEach((v) => scanStrings(v, fn, depth + 1));
  else if (x && typeof x === "object") for (const v of Object.values(x)) scanStrings(v, fn, depth + 1);
}

function lower(v: unknown): string | undefined {
  return typeof v === "string" && v ? v.toLowerCase() : undefined;
}

function portLabel(from: unknown, protocol: unknown, to?: unknown): string | undefined {
  const p = typeof protocol === "string" && protocol !== "-1" ? protocol.toLowerCase() : protocol === "-1" ? "all" : undefined;
  if (from === undefined || from === null) return p;
  const range = to !== undefined && to !== from ? `${from}-${to}` : String(from);
  if (from === 0 && (to === 0 || to === 65535)) return p === "all" ? "all traffic" : `${p ?? ""} all ports`.trim();
  return p ? `${p}/${range}` : range;
}

function compact(o: Record<string, unknown>) {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === "") delete o[k];
  return o;
}
