import type { Insight } from "@noodles/schema";
import type { Rule } from "../rule.js";

const CRITICAL = /^(pass(word)?|passwd|pwd|secret|client_secret|token|access_token|refresh_token|api_?key|authorization|card(_?number)?|cc_?num(ber)?|cvv|cvc|iban|ssn|social_security(_number)?)$/i;
const SENSITIVE = /(email|e_mail|phone|mobile|address|dob|date_of_birth|birth|first_?name|last_?name|full_?name|ip_?address|passport|national_id|tax_id)/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const CARD = /^\d{13,19}$/;

/** Find sensitive field names or values in a payload. */
export function sensitiveFields(value: unknown, path = "", out = new Map<string, "critical" | "warning">(), depth = 0): Map<string, "critical" | "warning"> {
  if (depth > 6 || value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((v) => sensitiveFields(v, `${path}[]`, out, depth + 1));
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (CRITICAL.test(k)) out.set(p, "critical");
      else if (SENSITIVE.test(k)) out.set(p, out.get(p) ?? "warning");
      sensitiveFields(v, p, out, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    if (EMAIL.test(value)) out.set(path || "(value)", out.get(path) ?? "warning");
    else if (CARD.test(value.replace(/[\s-]/g, "")) && luhn(value.replace(/[\s-]/g, ""))) out.set(path || "(value)", "critical");
  }
  return out;
}

function luhn(n: string): boolean {
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Sensitive-looking fields flowing into third-party APIs. */
export const dataExposure: Rule = {
  id: "data-exposure",
  category: "risk",
  title: "Data exposure",
  description: "Personal or secret-looking fields observed in requests to external APIs. Based on field names and value shapes, so legitimate uses (sending an email to an email provider) show up too.",
  run(ctx) {
    const out: Insight[] = [];
    for (const n of ctx.graph.nodes) {
      if (n.kind !== "external_api") continue;
      const fields = new Map<string, "critical" | "warning">();
      const steps: string[] = [];
      let execution: string | undefined;
      for (const x of ctx.executions) {
        for (const s of x.steps) {
          if (s.node !== n.id) continue;
          const found = sensitiveFields(s.input);
          if (!found.size) continue;
          for (const [k, v] of found) if (fields.get(k) !== "critical") fields.set(k, v);
          steps.push(s.id);
          execution ??= x.id;
        }
      }
      const incoming = (ctx.in.get(n.id) ?? []).filter((e) => e.samples?.length);
      for (const e of incoming) for (const s of e.samples ?? []) sensitiveFields((s.value as { input?: unknown })?.input ?? s.value, "", fields);
      if (!fields.size) continue;
      const critical = [...fields.values()].includes("critical");
      const callers = [...new Set((ctx.in.get(n.id) ?? []).map((e) => e.from.node))];
      out.push({
        id: `data-exposure:${n.id}`,
        rule: "data-exposure",
        category: "risk",
        severity: critical ? "critical" : "warning",
        confidence: "medium",
        title: `${critical ? "Secret or payment" : "Personal"} data sent to ${n.name}`,
        detail: `Fields: ${[...fields.keys()].slice(0, 8).join(", ")}. Check that ${n.name} needs them and that your data processing agreement covers it.`,
        nodes: [n.id, ...callers.slice(0, 4)],
        edges: (ctx.in.get(n.id) ?? []).map((e) => e.id),
        execution: steps.length ? execution : undefined,
        steps: steps.length ? steps.slice(0, 20) : undefined,
        metadata: { fields: [...fields.keys()] },
      });
    }
    return out;
  },
};
