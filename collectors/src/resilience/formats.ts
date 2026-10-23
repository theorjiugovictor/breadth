// Spec-driven development formats besides OpenSpec, read into the same model (a change with
// tasks, holding a capability with requirements and scenarios). Browser-safe.
//
//   Spec Kit (github/spec-kit)  specs/<NNN-feature>/spec.md, plan.md, tasks.md
//   Kiro                        .kiro/specs/<feature>/requirements.md, design.md, tasks.md

import { listLine, parseSlos, slug, type Capability, type Change, type Requirement, type Scenario } from "./openspec.js";

/** Checkbox progress: "- [x] T001 ...", "- [ ] 1.2 ..." */
function tasks(text: string | undefined): { done: number; total: number } {
  const boxes = [...(text ?? "").matchAll(/^\s*[-*]\s*\[( |x|X)\]/gm)];
  return { done: boxes.filter((b) => b[1].toLowerCase() === "x").length, total: boxes.length };
}

/**
 * Tasks grouped by what they name. Spec Kit labels a task with its story ("- [ ] T012 [US1] ...");
 * Kiro lists requirement numbers under it ("_Requirements: 1.2, 3.1_"), which count for the
 * task they sit under.
 */
function tasksBy(text: string | undefined, keysOf: (task: string, block: string) => string[]): Map<string, { done: number; total: number }> {
  const out = new Map<string, { done: number; total: number }>();
  const lines = (text ?? "").split("\n");
  lines.forEach((l, i) => {
    const m = l.match(/^(\s*)[-*]\s*\[( |x|X)\]/);
    if (!m) return;
    // the task's own lines, up to the next task or sub-task (sub-tasks count for themselves)
    const block: string[] = [];
    for (let j = i + 1; j < lines.length && !/^\s*[-*]\s*\[( |x|X)\]/.test(lines[j]); j++) block.push(lines[j]);
    for (const k of new Set(keysOf(l, block.join("\n")))) {
      const t = out.get(k) ?? { done: 0, total: 0 };
      t.total++;
      if (m[2].toLowerCase() === "x") t.done++;
      out.set(k, t);
    }
  });
  return out;
}

const CLARIFY = /\[NEEDS CLARIFICATION:?\s*([^\]]*)\]/gi;
const clarifications = (text: string) => [...text.matchAll(CLARIFY)].map((m) => m[1].trim() || "unspecified");
/** Template leftovers and separators: "---", "[Add more user stories as needed]", HTML comments. */
const filler = (line: string) => /^\s*(---+|\[[^\]]*\]|\*[^*]+\*)\s*$/.test(line);
const stripComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ""));

/** Breadth's three optional lines, in any format: Implemented by, Verified by, Target. */
function references(line: string, req: Requirement, sc?: Scenario): boolean {
  const impl = listLine(line, /implemented\s+by|implementation/);
  const ver = listLine(line, /verified\s+by/);
  const tgt = listLine(line, /targets?/);
  if (impl) req.implementedBy.push(...impl);
  else if (ver) (sc ?? req).verifiedBy.push(...ver);
  else if (tgt) (sc ?? req).targets.push(...tgt);
  return !!(impl || ver || tgt);
}

const scenario = (req: Requirement, name: string, text: string, line: number): Scenario => ({
  id: `scenario:${req.id.slice(4)}/${slug(name).slice(0, 60) || String(req.scenarios.length + 1)}`,
  name,
  steps: [text],
  slos: parseSlos(text),
  targets: [],
  verifiedBy: [],
  line,
});

/** Spec Kit's spec.md has these; a plain specs/ folder of test specs does not. */
export function isSpecKit(spec: string): boolean {
  return /^#\s+Feature Specification/m.test(spec) || (/\*\*FR-\d+\*\*/.test(spec) && /User (Story|Scenarios)/i.test(spec));
}

/** Spec Kit: user stories (with Given/When/Then acceptance scenarios), FR-xxx requirements, SC-xxx success criteria. */
export function parseSpecKit(feature: string, file: string, specText: string, tasksText?: string): { change: Change; capability: Capability } {
  const spec = stripComments(specText);
  const lines = spec.split("\n");
  const title = lines.find((l) => /^#\s/.test(l))?.replace(/^#\s+(Feature Specification:\s*)?/i, "").trim() || feature;
  const branch = spec.match(/\*\*Feature Branch\*\*:\s*`?([^`\s]+)`?/)?.[1];
  const why = spec.match(/\*\*Input\*\*:\s*(?:User description:\s*)?"?([^"\n]+)/)?.[1];
  const cap: Capability = { id: `spec:${feature}`, name: title, file, change: feature, requirements: [] };
  let req: Requirement | undefined;
  let sc: Scenario | undefined;
  let section = "";
  let success: Requirement | undefined;
  const newReq = (id: string, name: string, text: string, line: number): Requirement => {
    const r: Requirement = { id: `req:${feature}/${id}`, name, text, implementedBy: [], verifiedBy: [], targets: [], scenarios: [], line, delta: "added" };
    cap.requirements.push(r);
    return r;
  };
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      section = h2[1].toLowerCase();
      req = undefined;
      sc = undefined;
      return;
    }
    const story = line.match(/^###\s+User Story\s+(\d+)\s*[-–:]\s*(.+?)\s*(?:\(Priority:\s*(P\d)\))?\s*$/i);
    if (story) {
      req = newReq(`us${story[1]}-${slug(story[2])}`, story[2].trim(), "", i + 1);
      if (story[3]) req.text = `Priority ${story[3]}.`;
      sc = undefined;
      return;
    }
    if (/^###\s/.test(line)) {
      // Edge Cases, Functional Requirements, Key Entities, Measurable Outcomes: sub-sections
      if (!/^###\s+(Functional Requirements|Measurable Outcomes)/i.test(line)) req = undefined;
      sc = undefined;
      return;
    }
    const fr = line.match(/^\s*[-*]\s*\*\*(FR-\d+)\*\*:?\s*(.+)$/);
    if (fr) {
      req = newReq(fr[1].toLowerCase(), `${fr[1]}: ${fr[2].replace(/\*\*/g, "").slice(0, 120)}`, fr[2].replace(/\*\*/g, ""), i + 1);
      sc = undefined;
      return;
    }
    const scm = line.match(/^\s*[-*]\s*\*\*(SC-\d+)\*\*:?\s*(.+)$/);
    if (scm) {
      success ??= newReq("success-criteria", "Success criteria", "Measurable outcomes of the feature", i + 1);
      sc = { ...scenario(success, scm[1], scm[2].replace(/\*\*/g, ""), i + 1), name: `${scm[1]}: ${scm[2].replace(/\*\*/g, "").slice(0, 100)}` };
      success.scenarios.push(sc);
      req = success;
      return;
    }
    if (!req || !line.trim() || filler(line)) return;
    if (references(line, req, sc)) return;
    const accept = line.match(/^\s*\d+\.\s*(\*\*Given\*\*.+)$/i);
    if (accept && section.startsWith("user scenarios")) {
      const text = accept[1].replace(/\*\*/g, "");
      sc = scenario(req, text.length > 80 ? `${text.slice(0, 79)}…` : text, text, i + 1);
      req.scenarios.push(sc);
      return;
    }
    if (section.startsWith("user scenarios") && !/^\*\*(Why this priority|Independent Test|Acceptance Scenarios)\*\*/.test(line.trim())) req.text = `${req.text ? `${req.text} ` : ""}${line.trim()}`.slice(0, 600);
  });
  for (const r of cap.requirements) {
    const q = [...new Set(clarifications(`${r.name} ${r.text}`))];
    if (q.length) r.clarify = q;
  }
  const byStory = tasksBy(tasksText, (t) => [...t.matchAll(/\[(US\d+)\]/gi)].map((m) => m[1].toLowerCase()));
  for (const r of cap.requirements) {
    const us = r.id.match(/\/(us\d+)-/)?.[1];
    if (us && byStory.has(us)) r.tasks = byStory.get(us);
  }
  const change: Change = { id: feature, title, why, tasks: tasks(tasksText), file, format: "spec-kit", branch };
  return { change, capability: cap };
}

/** Kiro: numbered requirements with a user story and EARS acceptance criteria (WHEN ... THEN the system SHALL ...). */
export function parseKiro(feature: string, file: string, requirementsText: string, tasksText?: string): { change: Change; capability: Capability } {
  const requirements = stripComments(requirementsText);
  const lines = requirements.split("\n");
  const intro = requirements.match(/##\s+Introduction\s*\n+([\s\S]*?)(\n##|$)/i)?.[1].trim().split("\n")[0];
  const cap: Capability = { id: `spec:${feature}`, name: feature.replace(/[-_]/g, " "), purpose: intro, file, change: feature, requirements: [] };
  let req: Requirement | undefined;
  let sc: Scenario | undefined;
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const h = line.match(/^###\s+Requirement\s+(\d+)\s*:?\s*(.*)$/i);
    if (h) {
      req = { id: `req:${feature}/requirement-${h[1]}`, name: h[2].trim() || `Requirement ${h[1]}`, text: "", implementedBy: [], verifiedBy: [], targets: [], scenarios: [], line: i + 1, delta: "added" };
      cap.requirements.push(req);
      sc = undefined;
      return;
    }
    if (!req || !line.trim()) return;
    const story = line.match(/^\*\*User Story:?\*\*:?\s*(.+)$/i);
    if (story) {
      req.text = story[1].trim();
      // "As a support agent, I want to refund many orders, so that ..." -> the want, as the name
      const want = story[1].match(/I want(?: to)?\s+(.+?)(?:,\s*so that|\.|$)/i)?.[1];
      if (want && /^Requirement \d+$/.test(req.name)) req.name = want.charAt(0).toUpperCase() + want.slice(1);
      return;
    }
    if (references(line, req, sc)) return;
    const crit = line.match(/^\s*\d+\.\s*((?:WHEN|IF|WHILE|WHERE|THE)\b.+)$/i);
    if (crit) {
      sc = scenario(req, crit[1].slice(0, 80), crit[1], i + 1);
      req.scenarios.push(sc);
    }
  });
  // "_Requirements: 1.1, 2.3_" under a task: requirement 1 and 2
  const byReq = tasksBy(tasksText, (_t, block) => [...block.matchAll(/_?Requirements?:\s*([0-9., ]+)/gi)].flatMap((m) => m[1].split(/[,\s]+/).filter(Boolean).map((x) => x.split(".")[0])));
  for (const r of cap.requirements) {
    const n = r.id.match(/requirement-(\d+)$/)?.[1];
    if (n && byReq.has(n)) r.tasks = byReq.get(n);
  }
  const title = cap.requirements[0] ? `${cap.name}` : feature;
  return { change: { id: feature, title, why: intro, tasks: tasks(tasksText), file, format: "kiro" }, capability: cap };
}
