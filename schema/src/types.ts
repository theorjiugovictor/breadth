// TypeScript mirror of flowgraph.schema.json. Keep the two in sync.

export const SCHEMA_VERSION = "1.0" as const;

export const NODE_KINDS = [
  "function",
  "module",
  "service",
  "datastore",
  "queue",
  "external_api",
  "network_endpoint",
  "infra_resource",
  "pipeline",
  "team",
  "system",
  "org",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const LAYERS = ["code", "runtime", "network", "messaging", "infra", "delivery", "org"] as const;
export type Layer = (typeof LAYERS)[number];

export const EDGE_KINDS = ["call", "data", "network", "event", "read", "write", "deploy", "depends_on"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export type Status = "ok" | "error" | "unset";

export interface Port {
  name: string;
  type?: string;
  description?: string;
  optional?: boolean;
  default?: string;
}

export interface SourceRef {
  file?: string;
  line?: number;
  endLine?: number;
  resource_ref?: string;
  url?: string;
}

export type Metadata = Record<string, unknown>;

export interface FlowNode {
  id: string;
  name: string;
  description?: string;
  kind: NodeKind;
  layer: Layer;
  parent?: string;
  aliases?: string[];
  inputs?: Port[];
  outputs?: Port[];
  source?: SourceRef;
  tags?: string[];
  metadata?: Metadata;
}

export interface Endpoint {
  node: string;
  port?: string;
}

export interface Sample {
  value?: unknown;
  observedAt?: number;
  execution?: string;
  truncated?: boolean;
}

export interface FlowEdge {
  id: string;
  from: Endpoint;
  to: Endpoint;
  kind: EdgeKind;
  protocol?: string;
  label?: string;
  loop?: boolean;
  conditional?: boolean;
  count?: number;
  samples?: Sample[];
  metadata?: Metadata;
}

export interface Step {
  id: string;
  node: string;
  parent?: string;
  via?: string;
  input?: unknown;
  output?: unknown;
  start?: number;
  end?: number;
  status?: Status;
  error?: string;
  metadata?: Metadata;
}

export interface Execution {
  id: string;
  name?: string;
  start?: number;
  end?: number;
  status?: Status;
  steps: Step[];
  metadata?: Metadata;
}

export type Severity = "info" | "warning" | "critical";
export type InsightCategory = "inefficiency" | "redundancy" | "risk";

/** A finding over the graph. Signals, not verdicts. */
export interface Insight {
  id: string;
  rule: string;
  category?: InsightCategory;
  severity: Severity;
  confidence?: "low" | "medium" | "high";
  title: string;
  detail?: string;
  /** Nodes to highlight; the first one is the subject. */
  nodes: string[];
  edges?: string[];
  execution?: string;
  steps?: string[];
  metadata?: Metadata;
}

export interface GraphSource {
  collector: string;
  collectorVersion?: string;
  target?: string;
  collectedAt?: string;
}

export interface FlowGraph {
  version: typeof SCHEMA_VERSION;
  generatedAt?: string;
  sources?: GraphSource[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  executions?: Execution[];
  insights?: Insight[];
}

export function emptyGraph(): FlowGraph {
  return { version: SCHEMA_VERSION, nodes: [], edges: [] };
}
