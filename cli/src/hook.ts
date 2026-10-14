import path from "node:path";

/**
 * Coding-agent hook events, normalised. Every agent has its own hook format; `noodles hook`
 * reads whichever one arrives on stdin and forwards this shape to `noodles watch`.
 */
export interface AgentEvent {
  agent: string;
  event?: string;
  tool?: string;
  /** Absolute paths when the agent reported a working directory, else as given. */
  files: string[];
  prompt?: string;
  session?: string;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export const AGENTS = {
  claude: "Claude Code",
  copilot: "Copilot",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  windsurf: "Windsurf",
  antigravity: "Antigravity",
  codex: "Codex",
} as const;
export type AgentId = keyof typeof AGENTS;

const GEMINI_EVENTS = new Set(["BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool", "BeforeModel", "AfterModel", "BeforeToolSelection"]);

/** Which agent sent this payload, from fields only that agent's format has. */
export function detectAgent(raw: Raw, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (raw.cursor_version !== undefined) return AGENTS.cursor;
  if (raw.agent_action_name !== undefined) return AGENTS.windsurf;
  if (raw.toolCall !== undefined || raw.workspacePaths !== undefined || raw.stepIdx !== undefined) return AGENTS.antigravity;
  if (GEMINI_EVENTS.has(String(raw.hook_event_name))) return AGENTS.gemini;
  if (raw.tool_name === "apply_patch") return AGENTS.codex;
  // Claude Code sets CLAUDE_PROJECT_DIR for its hooks. VS Code also runs the hooks in
  // .claude/settings.json, so the same format without it means Copilot.
  if (raw.hook_event_name !== undefined) return env.CLAUDE_PROJECT_DIR ? AGENTS.claude : AGENTS.copilot;
  return undefined;
}

/** Tools that only look at files; agents whose matchers are ignored (VS Code) still send them. */
const READ_ONLY_TOOL = /^(read|view|list|search|grep|glob|find|fetch|get|open|semantic|codebase|file_search|ls\b)|_(read|search|list)$/i;
/** Argument names that carry a file path in some agent's edit tools. */
const PATH_KEY = /^(file_?path|filepath|path|paths|files|file|notebook_?path|target_?file|absolute_?path|uri)$/i;

function collectPaths(v: unknown, out: string[], depth = 0, keyed = false) {
  if (depth > 4 || v == null) return;
  if (typeof v === "string") {
    if (keyed) out.push(v.replace(/^file:\/\//, ""));
    // Codex (apply_patch) and others send the patch text itself.
    for (const m of v.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) out.push((m[1] ?? m[2]).trim());
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectPaths(x, out, depth + 1, keyed);
    return;
  }
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (PATH_KEY.test(k)) collectPaths(x, out, depth + 1, true);
      else if (typeof x === "object" || (typeof x === "string" && x.includes("*** "))) collectPaths(x, out, depth + 1, false);
    }
  }
}

/** Map any supported agent's hook payload (or a plain {files, prompt}) to an agent event. */
export function hookPayload(raw: Raw, agent?: string, env: NodeJS.ProcessEnv = process.env): AgentEvent {
  const info = obj(raw.tool_info);
  const call = obj(raw.toolCall);
  const tool = str(raw.tool_name) ?? str(raw.tool) ?? str(call.name);
  const files: string[] = [];
  if (!tool || !READ_ONLY_TOOL.test(tool)) {
    for (const v of [raw.tool_input, call.args, raw.file_path, info.file_path]) collectPaths(v, files, 0, typeof v === "string");
  }
  if (Array.isArray(raw.files)) files.push(...raw.files.filter((f): f is string => typeof f === "string"));
  const cwd = str(raw.cwd) ?? str((raw.workspace_roots as unknown[] | undefined)?.[0]) ?? str((raw.workspacePaths as unknown[] | undefined)?.[0]);
  const resolved = [...new Set(files.filter(Boolean).map((f) => (cwd && !path.isAbsolute(f) ? path.resolve(cwd, f) : f)))];
  return {
    agent: agent ?? str(raw.agent) ?? detectAgent(raw, env) ?? "agent",
    event: str(raw.hook_event_name) ?? str(raw.agent_action_name) ?? str(raw.event),
    tool,
    files: resolved,
    prompt: str(raw.prompt) ?? str(info.user_prompt) ?? str(raw.user_prompt),
    session: str(raw.session_id) ?? str(raw.conversation_id) ?? str(raw.trajectory_id) ?? str(raw.conversationId) ?? str(raw.session),
  };
}

/**
 * What to print on stdout so the agent carries on untouched. Gemini CLI and Antigravity
 * expect JSON; Claude Code and Codex would add any text to the model's context, so nothing.
 */
export function hookReply(raw: Raw, explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const agent = explicit ?? detectAgent(raw, env);
  if (agent === AGENTS.cursor) return raw.hook_event_name === "beforeSubmitPrompt" ? '{"continue":true}\n' : "{}\n";
  if (agent === AGENTS.gemini || agent === AGENTS.antigravity || agent === AGENTS.copilot) return "{}\n";
  return "";
}
