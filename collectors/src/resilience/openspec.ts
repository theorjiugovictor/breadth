// OpenSpec (openspec/specs/<capability>/spec.md, openspec/changes/<change>/...) read into
// capabilities, requirements and scenarios, with the scenario's success criteria made
// machine-readable so evidence can be judged against them without anyone reading prose.
// Browser-safe.

export interface Slo {
  /** p95_ms, p99_ms, error_pct, availability_pct, throughput_rps, recovery_s */
  metric: string;
  op: "<=" | "<" | ">=" | ">" | "==";
  value: number;
  /** The phrase it came from: "p95 <= 200 ms". */
  text: string;
}

export interface Scenario {
  id: string;
  name: string;
  /** WHEN / GIVEN / THEN / AND lines, as written */
  steps: string[];
  slos: Slo[];
  targets: string[];
  verifiedBy: string[];
  line: number;
}

export interface Requirement {
  id: string;
  name: string;
  text: string;
  /** added / modified / removed in a change; undefined in a current spec */
  delta?: "added" | "modified" | "removed" | "renamed";
  implementedBy: string[];
  verifiedBy: string[];
  targets: string[];
  scenarios: Scenario[];
  line: number;
}

export interface Capability {
  id: string;
  name: string;
  purpose?: string;
  file: string;
  /** The change proposing it, for specs under openspec/changes/<id>/specs/ */
  change?: string;
  requirements: Requirement[];
}

export interface Change {
  id: string;
  title: string;
  why?: string;
  tasks: { done: number; total: number };
  file: string;
  /** openspec, spec-kit, kiro */
  format?: string;
  /** OpenSpec changes/archive/: done and merged into the specs */
  archived?: boolean;
  /** Spec Kit: the git branch the feature is built on */
  branch?: string;
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const OPS: Record<string, Slo["op"]> = {
  "<=": "<=", "≤": "<=", "=<": "<=", "<": "<", ">=": ">=", "≥": ">=", "=>": ">=", ">": ">", "==": "==", "=": "==",
  under: "<", below: "<", "less than": "<", "lower than": "<", "at most": "<=", "no more than": "<=", within: "<=",
  above: ">", over: ">", "more than": ">", "at least": ">=", "no less than": ">=",
};
const opOf = (s: string) => OPS[s.toLowerCase().replace(/\s+/g, " ")];

/** Success criteria in a sentence: "p95 <= 200 ms and errors <= 1 %", "availability >= 99.9%", "recovers within 30 s". */
export function parseSlos(text: string): Slo[] {
  const out: Slo[] = [];
  const t = text.replace(/\*\*/g, "");
  const num = "(\\d+(?:\\.\\d+)?)";
  // symbols, or the words specs use: "under 200 ms", "less than 1 %", "at least 99.9 %"
  const op = "(<=|≤|=<|<|>=|≥|=>|>|==|=|under|below|less than|lower than|at most|no more than|within|above|over|more than|at least|no less than)";
  for (const m of t.matchAll(new RegExp(`\\bp(50|90|95|99|999)\\s*(?:latency\\s*)?${op}\\s*${num}\\s*(ms|s)\\b`, "gi"))) {
    out.push({ metric: `p${m[1]}_ms`, op: opOf(m[2]), value: Number(m[3]) * (m[4].toLowerCase() === "s" ? 1000 : 1), text: m[0] });
  }
  for (const m of t.matchAll(new RegExp(`\\berrors?(?:\\s*(?:rate|ratio))?\\s*${op}\\s*${num}\\s*%`, "gi"))) out.push({ metric: "error_pct", op: opOf(m[1]), value: Number(m[2]), text: m[0] });
  for (const m of t.matchAll(new RegExp(`\\b(?:availability|success(?:\\s*rate)?)\\s*${op}\\s*${num}\\s*%`, "gi"))) out.push({ metric: "availability_pct", op: opOf(m[1]), value: Number(m[2]), text: m[0] });
  for (const m of t.matchAll(new RegExp(`\\bthroughput\\s*${op}\\s*${num}\\s*(?:req|requests)\\s*/\\s*s`, "gi"))) out.push({ metric: "throughput_rps", op: opOf(m[1]), value: Number(m[2]), text: m[0] });
  for (const m of t.matchAll(new RegExp(`\\brecover(?:s|y)?\\s*(?:with)?in\\s*${num}\\s*(s|ms|min)\\b`, "gi"))) {
    const f = m[2].toLowerCase() === "ms" ? 0.001 : m[2].toLowerCase() === "min" ? 60 : 1;
    out.push({ metric: "recovery_s", op: "<=", value: Number(m[1]) * f, text: m[0] });
  }
  // "less than 1% errors", "99.9% availability": the number before the metric
  for (const m of t.matchAll(new RegExp(`${op}\\s*${num}\\s*%\\s*(?:of\\s+requests\\s+)?(?:errors?|error rate|failed requests|failures)\\b`, "gi"))) out.push({ metric: "error_pct", op: opOf(m[1]), value: Number(m[2]), text: m[0] });
  for (const m of t.matchAll(new RegExp(`(?:${op}\\s*)?${num}\\s*%\\s*(?:availability|uptime|success(?:\\s*rate)?)\\b`, "gi"))) if (!out.some((o) => o.metric === "availability_pct")) out.push({ metric: "availability_pct", op: m[1] ? opOf(m[1]) : ">=", value: Number(m[2]), text: m[0] });
  for (const m of t.matchAll(/\b(?:no|zero)\s+(?:5\d\d|errors|crash(?:es)?)\b/gi)) out.push({ metric: "error_pct", op: "<=", value: 0, text: m[0] });
  return out;
}

export type Verdict = "supports" | "contradicts" | "inconclusive";

export interface Check {
  metric: string;
  op: Slo["op"];
  expected: number;
  actual?: number;
  ok?: boolean;
}

/** Judge measured results against success criteria. Missing measurements make it inconclusive, never a pass. */
export function evaluateSlos(slos: Slo[], results: Record<string, number | undefined>): { verdict: Verdict; checks: Check[] } {
  const checks: Check[] = slos.map((s) => {
    const actual = results[s.metric];
    if (typeof actual !== "number" || Number.isNaN(actual)) return { metric: s.metric, op: s.op, expected: s.value };
    const ok = s.op === "<=" ? actual <= s.value : s.op === "<" ? actual < s.value : s.op === ">=" ? actual >= s.value : s.op === ">" ? actual > s.value : actual === s.value;
    return { metric: s.metric, op: s.op, expected: s.value, actual, ok };
  });
  const verdict: Verdict = !checks.length ? "inconclusive" : checks.some((c) => c.ok === false) ? "contradicts" : checks.every((c) => c.ok === true) ? "supports" : "inconclusive";
  return { verdict, checks };
}

/** "Implemented by: checkout(), workload/app.py" style lines (bold or not, any case). */
export function listLine(line: string, label: RegExp): string[] | undefined {
  const m = line.replace(/\*\*/g, "").match(new RegExp(`^\\s*[-*]?\\s*(?:${label.source})\\s*:\\s*(.+)$`, "i"));
  return m ? m[1].split(/,\s*|;\s*/).map((x) => x.replace(/`/g, "").trim()).filter(Boolean) : undefined;
}

export function parseSpec(text: string, file: string, capability: string, change?: string): Capability {
  const lines = text.split("\n");
  const cap: Capability = { id: change ? `change:${change}/spec:${capability}` : `spec:${capability}`, name: capability, file, change, requirements: [] };
  const title = lines.find((l) => /^#\s/.test(l));
  if (title) cap.name = title.replace(/^#\s+/, "").replace(/\s+Specification$/i, "").trim() || capability;
  let delta: Requirement["delta"];
  let req: Requirement | undefined;
  let sc: Scenario | undefined;
  let section = "";
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      section = h2[1].trim().toLowerCase();
      const d = section.match(/^(added|modified|removed|renamed)\s+requirements/);
      delta = d ? (d[1] as Requirement["delta"]) : undefined;
      req = undefined;
      sc = undefined;
      return;
    }
    const r = line.match(/^###\s+Requirement:\s*(.+)$/i);
    if (r) {
      const name = r[1].trim();
      req = { id: `req:${capability}/${slug(name)}`, name, text: "", delta, implementedBy: [], verifiedBy: [], targets: [], scenarios: [], line: i + 1 };
      cap.requirements.push(req);
      sc = undefined;
      return;
    }
    const s = line.match(/^####\s+Scenario:\s*(.+)$/i);
    if (s && req) {
      const name = s[1].trim();
      sc = { id: `scenario:${capability}/${slug(req.name)}/${slug(name)}`, name, steps: [], slos: [], targets: [], verifiedBy: [], line: i + 1 };
      req.scenarios.push(sc);
      return;
    }
    if (section === "purpose" && !req && line.trim()) cap.purpose = (cap.purpose ? `${cap.purpose} ` : "") + line.trim();
    if (!req || !line.trim()) return;
    const impl = listLine(line, /implemented\s+by|implementation/);
    const ver = listLine(line, /verified\s+by|tests?/);
    const tgt = listLine(line, /targets?/);
    if (impl) req.implementedBy.push(...impl);
    else if (ver) (sc ?? req).verifiedBy.push(...ver);
    else if (tgt) (sc ?? req).targets.push(...tgt);
    else if (sc) {
      sc.steps.push(line.replace(/^\s*[-*]\s*/, "").replace(/\*\*/g, ""));
      sc.slos.push(...parseSlos(line));
    } else req.text = (req.text ? `${req.text} ` : "") + line.trim();
  });
  return cap;
}

export function parseChange(id: string, proposal: string | undefined, tasks: string | undefined, file: string): Change {
  const title = proposal?.split("\n").find((l) => /^#\s/.test(l))?.replace(/^#\s+(Change:\s*)?/i, "").trim() ?? id;
  const why = proposal?.match(/##\s+Why\s*\n+([\s\S]*?)(\n##|$)/i)?.[1].trim().split("\n")[0];
  const boxes = [...(tasks ?? "").matchAll(/^\s*[-*]\s*\[( |x|X)\]/gm)];
  return { id, title, why, tasks: { done: boxes.filter((b) => b[1].toLowerCase() === "x").length, total: boxes.length }, file };
}
