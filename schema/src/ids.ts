import type { EdgeKind, Endpoint } from "./types.js";

/** Default stable edge id: '<kind>:<from>[.port]-><to>[.port]'. */
export function edgeId(kind: EdgeKind, from: Endpoint, to: Endpoint): string {
  const end = (e: Endpoint) => (e.port ? `${e.node}.${e.port}` : e.node);
  return `${kind}:${end(from)}->${end(to)}`;
}

/** Normalise a filesystem path to forward slashes without a leading './'. */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}
