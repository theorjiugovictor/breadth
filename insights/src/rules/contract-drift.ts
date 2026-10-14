import type { Insight, Port } from "@noodles/schema";
import type { Rule } from "../rule.js";

type Kind = "number" | "string" | "boolean" | "array" | "object" | "null";

/** Declared type -> JSON kinds it accepts. Undefined = cannot judge (classes, generics we do not know). */
export function expectedKinds(type?: string): Set<Kind> | undefined {
  if (!type) return undefined;
  let t = type.trim().replace(/^:\s*/, "");
  const optional = /^Optional\[/.test(t) || /\|\s*(None|null|undefined)\b/.test(t) || /\b(None|null|undefined)\s*\|/.test(t);
  t = t.replace(/^Optional\[(.*)\]$/, "$1");
  const parts = t.split("|").map((p) => p.trim()).filter((p) => !/^(None|null|undefined)$/.test(p));
  const kinds = new Set<Kind>();
  for (const p of parts) {
    if (/^(int|float|complex|Decimal|number|bigint)$/.test(p)) kinds.add("number");
    else if (/^(str|string|bytes|UUID|datetime|date|EmailStr)$/.test(p)) kinds.add("string");
    else if (/^(bool|boolean)$/.test(p)) kinds.add("boolean");
    else if (/^(list|List|tuple|Tuple|set|Set|Sequence|Iterable|Array)\b|\[\]$/.test(p)) kinds.add("array");
    else if (/^(dict|Dict|Mapping|Record|object)\b/.test(p)) kinds.add("object");
    else return undefined; // a class or alias: the JSON shape could be anything
  }
  if (!kinds.size) return undefined;
  if (optional) kinds.add("null");
  return kinds;
}

function kindOf(v: unknown): Kind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number" || typeof v === "bigint") return "number";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  return "object";
}

/** Real payloads that do not match the declared parameter / return types. */
export const contractDrift: Rule = {
  id: "contract-drift",
  category: "risk",
  title: "Contract drift",
  description: "Observed input or output values whose JSON type contradicts the declared type of the port, e.g. a string arriving where a float is declared.",
  run(ctx) {
    const out = new Map<string, Insight>();
    for (const x of ctx.executions) {
      for (const s of x.steps) {
        const n = ctx.node(s.node);
        if (!n?.inputs?.length && !n?.outputs?.length) continue;
        const check = (port: Port, value: unknown, side: "input" | "output") => {
          const want = expectedKinds(port.type);
          if (!want || value === undefined) return;
          const got = kindOf(value);
          if (want.has(got)) return;
          const id = `contract-drift:${n.id}:${side}:${port.name}`;
          const prev = out.get(id);
          if (prev) {
            prev.steps!.push(s.id);
            return;
          }
          out.set(id, {
            id,
            rule: "contract-drift",
            category: "risk",
            severity: "warning",
            confidence: "high",
            title: `${n.name} ${side === "input" ? `received ${port.name} as ${got}` : `returned ${got}`}, declared ${port.type}`,
            detail: `Observed ${JSON.stringify(value)?.slice(0, 80)} in "${x.name ?? x.id}". The caller and the declaration disagree; this works until something relies on the declared type (arithmetic, comparisons, serialisation).`,
            nodes: [n.id],
            edges: s.via ? [s.via] : undefined,
            execution: x.id,
            steps: [s.id],
            metadata: { port: port.name, declared: port.type, observed: got },
          });
        };
        if (s.input && typeof s.input === "object" && !Array.isArray(s.input)) {
          for (const p of n.inputs ?? []) if (p.name in (s.input as object)) check(p, (s.input as Record<string, unknown>)[p.name], "input");
        }
        const ret = n.outputs?.find((p) => p.name === "return");
        if (ret && s.output !== undefined) check(ret, s.output, "output");
      }
    }
    return [...out.values()];
  },
};
