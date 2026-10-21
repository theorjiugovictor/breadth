import type { Insight, Severity } from "@breadth/schema";
import type { Rule } from "../rule.js";

/** Ports that should never face the internet: remote shells, databases, caches, brokers, admin APIs. */
const SENSITIVE: Record<number, string> = {
  22: "SSH",
  23: "Telnet",
  3389: "RDP",
  5432: "PostgreSQL",
  3306: "MySQL",
  1433: "SQL Server",
  1521: "Oracle",
  27017: "MongoDB",
  6379: "Redis",
  11211: "Memcached",
  9200: "Elasticsearch",
  5601: "Kibana",
  9092: "Kafka",
  2375: "Docker",
  2379: "etcd",
  6443: "Kubernetes API",
  5984: "CouchDB",
  8086: "InfluxDB",
};

/** Port ranges in an edge label: "tcp/5432", "tcp/9092-9098", "all traffic", "tcp all ports", "22,80". */
export function portRanges(label: string | undefined): [number, number][] {
  if (!label) return [[0, 65535]];
  if (/all (traffic|ports)/.test(label) || label === "all") return [[0, 65535]];
  const out: [number, number][] = [];
  for (const m of label.matchAll(/(\d+)(?:-(\d+))?/g)) out.push([Number(m[1]), Number(m[2] ?? m[1])]);
  return out.length ? out : [[0, 65535]];
}

export function sensitivePorts(label: string | undefined): string[] {
  const ranges = portRanges(label);
  return Object.entries(SENSITIVE)
    .filter(([p]) => ranges.some(([a, b]) => Number(p) >= a && Number(p) <= b))
    .map(([p, name]) => `${name} (${p})`);
}

/** Network rules that let any address reach something that is not a public front door. */
export const internetExposed: Rule = {
  id: "internet-exposed",
  category: "risk",
  title: "Open to the internet",
  description: "Firewall or security group rules that let any address (0.0.0.0/0) reach a database, a remote shell, an admin port or a machine that is not a load balancer. Reads Terraform security groups and GCP / Azure firewall rules.",
  run(ctx) {
    const out: Insight[] = [];
    for (const e of ctx.out.get("net:internet") ?? []) {
      if (e.kind !== "network") continue;
      const n = ctx.node(e.to.node);
      if (!n) continue;
      const ports = sensitivePorts(e.label);
      const all = portRanges(e.label).some(([a, b]) => b - a > 1000);
      const frontDoor = n.kind === "network_endpoint";
      if (frontDoor && !ports.length) continue;
      const severity: Severity = ports.length || n.kind === "datastore" ? "critical" : "warning";
      out.push({
        id: `internet-exposed:${n.id}:${e.label ?? "all"}`,
        rule: "internet-exposed",
        category: "risk",
        severity,
        confidence: "high",
        title: `${n.name} is reachable from the internet${e.label ? ` on ${e.label}` : ""}`,
        detail: ports.length
          ? `Any address can connect to ${ports.join(", ")}${all ? " and every other port in the range" : ""}. Restrict the source to known networks or a bastion / VPN.`
          : `Any address can connect${all ? " on every port" : ""}. Unless this is meant to be public, put it behind a load balancer and restrict the rule's source.`,
        nodes: [n.id, e.from.node],
        edges: [e.id],
        metadata: { type: n.metadata?.type, resource: n.source?.resource_ref, ports },
      });
    }
    return out;
  },
};

export const publicData: Rule = {
  id: "public-data",
  category: "risk",
  title: "Public data store",
  description: "Storage that anyone can read: public S3 ACLs or bucket policies (unless a public access block overrides them), publicly accessible databases, GCS buckets shared with allUsers, public Azure containers.",
  run(ctx) {
    const out: Insight[] = [];
    for (const n of ctx.graph.nodes) {
      if (n.metadata?.public !== true) continue;
      out.push({
        id: `public-data:${n.id}`,
        rule: "public-data",
        category: "risk",
        severity: "critical",
        confidence: "high",
        title: `${n.name} is public`,
        detail: `${String(n.metadata.public_reason ?? "Its settings make it public")}. If that is not on purpose, anyone on the internet can read${n.metadata.type === "aws_db_instance" ? " (or try to log in to)" : ""} it.`,
        nodes: [n.id],
        metadata: { type: n.metadata.type, resource: n.source?.resource_ref, reason: n.metadata.public_reason },
      });
    }
    return out;
  },
};

export const unencryptedStorage: Rule = {
  id: "unencrypted-storage",
  category: "risk",
  title: "Unencrypted storage",
  description: "Databases, volumes and file systems created without encryption at rest (for these the provider default is off). Encryption can only be turned on by recreating most of them, so it is cheapest to catch at review.",
  run(ctx) {
    const out: Insight[] = [];
    for (const n of ctx.graph.nodes) {
      if (n.metadata?.encrypted !== false) continue;
      out.push({
        id: `unencrypted-storage:${n.id}`,
        rule: "unencrypted-storage",
        category: "risk",
        severity: "warning",
        confidence: "high",
        title: `${n.name} is not encrypted at rest`,
        detail: `${String(n.metadata.type ?? n.kind)} has encryption at rest off. Snapshots and backups inherit that, and turning it on later usually means recreating the resource.`,
        nodes: [n.id],
        metadata: { type: n.metadata.type, resource: n.source?.resource_ref },
      });
    }
    return out;
  },
};

export const broadIam: Rule = {
  id: "broad-iam",
  category: "risk",
  title: "Broad IAM permissions",
  description: "IAM roles allowed every action (\"*\"), every action of a service on every resource (s3:* on *), or everything except a few actions (NotAction). Least privilege limits what a compromised workload can do.",
  run(ctx) {
    const out: Insight[] = [];
    for (const n of ctx.graph.nodes) {
      const broad = n.metadata?.iam_broad as string[] | undefined;
      if (!broad?.length) continue;
      const admin = broad.some((b) => b.startsWith("* on *") || b.startsWith("everything except"));
      const users = n.metadata?.used_by as string[] | undefined;
      out.push({
        id: `broad-iam:${n.id}`,
        rule: "broad-iam",
        category: "risk",
        severity: admin ? "critical" : "warning",
        confidence: "high",
        title: `${n.name} ${admin ? "can do anything in the account" : `has broad permissions (${broad.join("; ")})`}`,
        detail: `Allows ${broad.join("; ")}${users?.length ? `, and ${users.join(", ")} run${users.length === 1 ? "s" : ""} as it` : ""}. Grant the specific actions and resources it needs instead.`,
        nodes: [n.id],
        metadata: { type: n.metadata?.type, resource: n.source?.resource_ref, broad },
      });
    }
    return out;
  },
};
