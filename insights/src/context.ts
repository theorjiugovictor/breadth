import type { Execution, FlowEdge, FlowGraph, FlowNode, Step } from "@noodles/schema";

/** Read-only indexes shared by all rules. Pure: no Node or DOM APIs, so it runs in the CLI and the browser. */
export class Ctx {
  readonly nodes: Map<string, FlowNode>;
  readonly out = new Map<string, FlowEdge[]>();
  readonly in = new Map<string, FlowEdge[]>();
  readonly executions: Execution[];
  /** Edge ids traversed in any execution. */
  readonly traversed = new Set<string>();
  /** Node ids seen in any execution. */
  readonly seen = new Set<string>();
  private serviceMemo = new Map<string, string | undefined>();
  /** service name (from aliases / names) -> service node id */
  private serviceByName = new Map<string, string>();

  constructor(readonly graph: FlowGraph) {
    this.nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const e of graph.edges) {
      push(this.out, e.from.node, e);
      push(this.in, e.to.node, e);
    }
    for (const n of graph.nodes) {
      if (n.kind !== "service") continue;
      for (const a of n.aliases ?? []) if (a.startsWith("service:")) this.serviceByName.set(a.slice(8), n.id);
      if (!this.serviceByName.has(n.name)) this.serviceByName.set(n.name, n.id);
    }
    this.executions = graph.executions ?? [];
    for (const x of this.executions) {
      for (const s of x.steps) {
        this.seen.add(s.node);
        if (s.via) this.traversed.add(s.via);
      }
    }
  }

  node(id: string): FlowNode | undefined {
    return this.nodes.get(id);
  }

  name(id: string): string {
    return this.nodes.get(id)?.name ?? id;
  }

  ancestors(id: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let cur = this.nodes.get(id)?.parent;
    while (cur && !seen.has(cur) && this.nodes.has(cur)) {
      seen.add(cur);
      out.push(cur);
      cur = this.nodes.get(cur)?.parent;
    }
    return out;
  }

  /** The service a node belongs to: itself or its nearest `service` ancestor. */
  serviceOf(id: string): string | undefined {
    if (this.serviceMemo.has(id)) return this.serviceMemo.get(id);
    const n = this.nodes.get(id);
    let svc: string | undefined;
    if (n?.kind === "service") svc = id;
    else svc = this.ancestors(id).find((a) => this.nodes.get(a)?.kind === "service");
    this.serviceMemo.set(id, svc);
    return svc;
  }

  /**
   * Service of a step. Shared nodes (datastores, topics, external APIs) belong to no service,
   * so the step counts for the service that issued it (the span's service.name).
   */
  stepService(s: Step): string | undefined {
    const n = this.nodes.get(s.node);
    const shared = n && (n.kind === "datastore" || n.kind === "queue" || n.kind === "external_api");
    const own = shared ? undefined : this.serviceOf(s.node);
    if (own) return own;
    const name = s.metadata?.service as string | undefined;
    return name ? (this.serviceByName.get(name) ?? name) : undefined;
  }

  isExternal(id: string): boolean {
    const n = this.nodes.get(id);
    return n?.kind === "external_api";
  }

  /** Module-level state: reading it is cheap, so it is not an N+1. */
  isInMemory(id: string): boolean {
    return this.nodes.get(id)?.metadata?.subkind === "global";
  }

  isStore(id: string): boolean {
    return this.nodes.get(id)?.kind === "datastore";
  }

  /**
   * Datastores a function reads from, directly or through callees up to `depth` calls away,
   * with the call path (nodes and edges) that leads to each read.
   */
  readsFrom(id: string, depth = 2): Map<string, { nodes: string[]; edges: string[] }> {
    const found = new Map<string, { nodes: string[]; edges: string[] }>();
    const visit = (n: string, d: number, nodes: string[], edges: string[], seen: Set<string>) => {
      if (seen.has(n)) return;
      seen.add(n);
      for (const e of this.in.get(n) ?? []) {
        if (e.kind === "read" && this.isStore(e.from.node) && !this.isInMemory(e.from.node) && !found.has(e.from.node)) {
          found.set(e.from.node, { nodes: [...nodes, n], edges: [...edges, e.id] });
        }
      }
      if (d === 0) return;
      for (const e of this.out.get(n) ?? []) if (e.kind === "call") visit(e.to.node, d - 1, [...nodes, n], [...edges, e.id], seen);
    };
    visit(id, depth, [], [], new Set());
    return found;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** Children of each step, by parent step id. */
export function stepChildren(x: Execution): Map<string, Step[]> {
  const m = new Map<string, Step[]>();
  for (const s of x.steps) if (s.parent) push(m, s.parent, s);
  return m;
}

export function duration(s: Step): number {
  return s.start !== undefined && s.end !== undefined ? s.end - s.start : 0;
}

export function stableJson(v: unknown): string {
  if (v === undefined) return "undefined";
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val,
  );
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
