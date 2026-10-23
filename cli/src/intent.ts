import type { BehaviorChange, IntentCheck } from "@breadth/schema";
import type { LLMProvider } from "./llm/provider.js";

/**
 * Checks a change against what it was asked to do. The structural diff says what the change
 * does; the request (a PR description, an agent's task) says what it should do. An LLM matches
 * the two and names the difference: work nobody asked for (a removed check, a widened
 * permission) and asked-for work the diff does not show.
 *
 * Only the request and the behaviour-change sentences are sent, never source code.
 */

const SYSTEM = `You review a code change for a busy engineer. You get (1) the request: what the change was supposed to do, written by a person or given to a coding agent, and (2) the change's effects, found by static analysis, one numbered line each.

Decide which effects the request asks for or clearly implies (including the plumbing it needs: new endpoints, storage, permissions it needs), which ones nothing in the request explains, and what the request asks for that no effect shows. Be strict about unrequested effects that weaken safety: removed checks, wider access, data exposed, things opened to the internet. Do not flag routine side effects of the requested work.

Reply with JSON only, no prose around it:
{"summary": "<one sentence, at most 30 words: does it do what was asked, and the most important thing it also does>",
 "matches": [<numbers of effects the request explains>],
 "unrequested": [{"change": <number>, "why": "<at most 15 words>"}],
 "missing": ["<asked-for thing not visible in the effects, at most 15 words>"]}`;

export const MAX_REQUEST_CHARS = 6000;
const MAX_CHANGES = 80;

export function intentPrompt(request: string, changes: BehaviorChange[]): string {
  const lines = changes.slice(0, MAX_CHANGES).map((c, i) => `${i + 1}. [${c.severity}] ${c.text}`);
  return `Request:\n"""\n${request.slice(0, MAX_REQUEST_CHARS)}\n"""\n\nEffects of the change:\n${lines.join("\n") || "(none)"}`;
}

/** Parse the model's reply, tolerating fences and stray prose. Indexes become 0-based. */
export function parseIntentReply(reply: string, changes: number): Omit<IntentCheck, "request"> | undefined {
  const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(json);
  } catch {
    return undefined;
  }
  const idx = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= changes ? v - 1 : undefined);
  const matches = (Array.isArray(o.matches) ? o.matches : []).map(idx).filter((x): x is number => x !== undefined);
  const unrequested = (Array.isArray(o.unrequested) ? o.unrequested : [])
    .map((u) => {
      const c = idx((u as Record<string, unknown>)?.change ?? u);
      const why = (u as Record<string, unknown>)?.why;
      return c === undefined ? undefined : { change: c, ...(typeof why === "string" && why ? { why: why.slice(0, 200) } : {}) };
    })
    .filter((x): x is { change: number; why?: string } => !!x);
  const missing = (Array.isArray(o.missing) ? o.missing : []).filter((m): m is string => typeof m === "string" && !!m.trim()).map((m) => m.slice(0, 200));
  return {
    summary: typeof o.summary === "string" ? o.summary.slice(0, 400) : undefined,
    matches: [...new Set(matches)].sort((a, b) => a - b),
    unrequested,
    missing,
  };
}

export async function checkIntent(request: string, changes: BehaviorChange[], llm: LLMProvider): Promise<IntentCheck | undefined> {
  const text = request.trim();
  if (!text) return undefined;
  const reply = await llm.complete({ system: SYSTEM, prompt: intentPrompt(text, changes), maxTokens: 900 });
  if (!reply) return undefined;
  const parsed = parseIntentReply(reply, Math.min(changes.length, MAX_CHANGES));
  if (!parsed) return undefined;
  return { request: text.slice(0, MAX_REQUEST_CHARS), ...parsed, model: llm.name };
}
