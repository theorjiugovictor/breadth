import {
  Box,
  Braces,
  Building2,
  Cloud,
  Cpu,
  Database,
  FileCode2,
  Globe,
  Inbox,
  Network,
  Package,
  Plug,
  Server,
  SquareFunction,
  Users,
  Variable,
  Workflow,
  Layers,
  FileCheck2,
  FlaskConical,
  ScrollText,
  ShieldCheck,
  ClipboardList,
  BadgeCheck,
  Fingerprint,
  GitPullRequestArrow,
  type LucideIcon,
} from "lucide-react";
import type { EdgeKind, FlowNode, Layer, NodeKind } from "@breadth/schema";

export const KIND_LABEL: Record<NodeKind, string> = {
  function: "Function",
  module: "Module",
  service: "Service",
  datastore: "Datastore",
  queue: "Queue",
  external_api: "External API",
  network_endpoint: "Endpoint",
  infra_resource: "Infra resource",
  pipeline: "Pipeline",
  team: "Team",
  system: "System",
  org: "Organisation",
  artifact: "Record",
};

const KIND_ICON: Record<NodeKind, LucideIcon> = {
  function: SquareFunction,
  module: Box,
  service: Server,
  datastore: Database,
  queue: Inbox,
  external_api: Globe,
  network_endpoint: Plug,
  infra_resource: Cloud,
  pipeline: Workflow,
  team: Users,
  system: Network,
  org: Building2,
  artifact: FileCheck2,
};

const KIND_COLOR: Record<NodeKind, string> = {
  function: "#7c5cff",
  module: "#64748b",
  service: "#2563eb",
  datastore: "#0e9f6e",
  queue: "#d97706",
  external_api: "#0891b2",
  network_endpoint: "#ff6d5a",
  infra_resource: "#4f46e5",
  pipeline: "#db2777",
  team: "#ea580c",
  system: "#334155",
  org: "#ea580c",
  artifact: "#9333ea",
};

/** Artifact roles (resilience-v1 profile): requirement, scenario, test, evidence, ... */
const ROLE_VISUAL: Record<string, { Icon: LucideIcon; color: string; label: string }> = {
  change: { Icon: GitPullRequestArrow, color: "#0f766e", label: "Spec change" },
  capability: { Icon: ScrollText, color: "#0f766e", label: "Capability" },
  requirement: { Icon: ClipboardList, color: "#0f766e", label: "Requirement" },
  scenario: { Icon: ClipboardList, color: "#14b8a6", label: "Scenario" },
  test: { Icon: FileCheck2, color: "#2563eb", label: "Test" },
  snapshot: { Icon: Fingerprint, color: "#475569", label: "Source snapshot" },
  experiment: { Icon: FlaskConical, color: "#9333ea", label: "Experiment" },
  approval: { Icon: BadgeCheck, color: "#ca8a04", label: "Approval" },
  evidence: { Icon: ShieldCheck, color: "#ca8a04", label: "Evidence" },
};

/** Semantic relations are indigo; evidence verdicts green / red. */
export function relationColor(relation: string): string {
  if (relation === "supports") return "var(--ok)";
  if (relation === "contradicts") return "var(--err)";
  return "#4f46e5";
}

/** Icon + colour for a node, refined by common metadata.subkind values. */
export function nodeVisual(n: FlowNode): { Icon: LucideIcon; color: string; label: string } {
  if (n.kind === "artifact") {
    const v = ROLE_VISUAL[n.role ?? ""];
    if (v) {
      const verdict = n.metadata?.verdict;
      const color = verdict === "supports" ? "#16a34a" : verdict === "contradicts" ? "#dc2626" : n.metadata?.stale ? "#94a3b8" : v.color;
      return { ...v, color };
    }
  }
  const sub = n.metadata?.subkind as string | undefined;
  const ext = n.metadata?.external === true;
  if (sub === "class") return { Icon: Braces, color: "#a855f7", label: "Class" };
  if (sub === "file") return { Icon: FileCode2, color: "#64748b", label: "File" };
  if (sub === "global") return { Icon: Variable, color: "#0e9f6e", label: "Shared state" };
  if (sub === "method") return { Icon: SquareFunction, color: "#7c5cff", label: "Method" };
  if (ext && n.kind === "module") return { Icon: Package, color: "#94a3b8", label: "Package" };
  if (n.kind === "infra_resource" && /k8s|kubernetes/i.test(String(n.metadata?.platform ?? ""))) return { Icon: Cpu, color: "#326ce5", label: String(n.metadata?.type ?? "Resource") };
  if (n.kind === "module" && n.metadata?.path) return { Icon: Layers, color: "#64748b", label: "Directory" };
  return { Icon: KIND_ICON[n.kind] ?? Box, color: KIND_COLOR[n.kind] ?? "#64748b", label: KIND_LABEL[n.kind] ?? n.kind };
}

export const LAYER_LABEL: Record<Layer, string> = {
  code: "Code",
  runtime: "Runtime",
  network: "Network",
  messaging: "Messaging",
  infra: "Infrastructure",
  delivery: "Delivery",
  org: "Organisation",
  resilience: "Resilience",
};

export const EDGE_STYLE: Record<EdgeKind, { label: string; dash?: string; width: number }> = {
  call: { label: "Call", width: 1.6 },
  data: { label: "Data", width: 1.8 },
  network: { label: "Network", dash: "7 5", width: 1.6 },
  event: { label: "Event", dash: "2 5", width: 2 },
  read: { label: "Read", width: 1.6 },
  write: { label: "Write", width: 1.6 },
  deploy: { label: "Deploy", dash: "10 4 2 4", width: 1.6 },
  depends_on: { label: "Depends on", dash: "4 4", width: 1.2 },
};

export const edgeColor = (k: EdgeKind) => `var(--edge-${k})`;

/** Concrete colours (SVG markers cannot use CSS variables). Keep in sync with app.css. */
export const EDGE_HEX: Record<"light" | "dark", Record<EdgeKind, string>> = {
  light: { call: "#a3a9b6", data: "#3b82f6", network: "#14b8a6", event: "#a855f7", read: "#10b981", write: "#f59e0b", deploy: "#ec4899", depends_on: "#b4b9c4" },
  dark: { call: "#6f7584", data: "#3b82f6", network: "#14b8a6", event: "#a855f7", read: "#10b981", write: "#f59e0b", deploy: "#ec4899", depends_on: "#5c616e" },
};
