import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS, type AgentId } from "./hook.js";

/** How to launch this CLI from an agent's config: `breadth` when linked, else node + this bundle. */
export function selfCommand(argv1 = process.argv[1] ?? "breadth"): { command: string; args: string[] } {
  if (path.basename(argv1).replace(/\.(cmd|exe)$/, "") === "breadth") return { command: "breadth", args: [] };
  return { command: "node", args: [path.resolve(argv1)] };
}

const quote = (s: string) => (/^[\w./:@=-]+$/.test(s) ? s : JSON.stringify(s));

export interface ConfigFile {
  /** Path relative to the project, or absolute (user-level files). */
  file: string;
  /** JSON merged into the file, or TOML appended to it. */
  json?: Record<string, unknown>;
  toml?: string;
  /** Shown next to the file. */
  note?: string;
  /** User-level files are printed, never written. */
  user?: boolean;
}

export interface Integration {
  id: AgentId;
  name: string;
  hooks: ConfigFile;
  mcp: ConfigFile;
  notes: string[];
}

export function integrations(port?: string): Integration[] {
  const self = selfCommand();
  const portArgs = port && port !== "4321" ? ["--port", port] : [];
  const hook = (agent?: string) => [self.command, ...self.args, "hook", ...portArgs, ...(agent ? ["--agent", agent] : [])].map(quote).join(" ");
  const mcpArgs = [...self.args, "mcp", ...portArgs];
  const cmd = (agent?: string) => ({ type: "command", command: hook(agent) });
  const stdio = { command: self.command, args: mcpArgs };
  return [
    {
      id: "claude",
      name: AGENTS.claude,
      // No --agent: VS Code runs these hooks too, and `breadth hook` tells the two apart.
      hooks: {
        file: ".claude/settings.json",
        json: {
          hooks: {
            UserPromptSubmit: [{ hooks: [cmd()] }],
            PostToolUse: [{ matcher: "Edit|MultiEdit|Write|NotebookEdit", hooks: [cmd()] }],
          },
        },
      },
      mcp: { file: ".mcp.json", json: { mcpServers: { breadth: stdio } } },
      notes: [],
    },
    {
      id: "copilot",
      name: AGENTS.copilot,
      hooks: { file: ".github/hooks/breadth.json", json: { hooks: { UserPromptSubmit: [cmd(AGENTS.copilot)], PostToolUse: [cmd(AGENTS.copilot)] } } },
      mcp: { file: ".vscode/mcp.json", json: { servers: { breadth: { type: "stdio", ...stdio } } } },
      notes: [
        "Agent hooks are a VS Code preview feature; your organisation may have them turned off.",
        "VS Code also runs Claude Code hooks from .claude/settings.json; breadth drops the duplicate events.",
      ],
    },
    {
      id: "cursor",
      name: AGENTS.cursor,
      hooks: { file: ".cursor/hooks.json", json: { version: 1, hooks: { beforeSubmitPrompt: [{ command: hook() }], afterFileEdit: [{ command: hook() }] } } },
      mcp: { file: ".cursor/mcp.json", json: { mcpServers: { breadth: stdio } } },
      notes: [],
    },
    {
      id: "gemini",
      name: AGENTS.gemini,
      hooks: {
        file: ".gemini/settings.json",
        json: {
          hooks: {
            BeforeAgent: [{ hooks: [{ ...cmd(), name: "breadth" }] }],
            AfterTool: [{ matcher: "write_file|replace|edit", hooks: [{ ...cmd(), name: "breadth" }] }],
          },
        },
      },
      mcp: { file: ".gemini/settings.json", json: { mcpServers: { breadth: stdio } } },
      notes: [],
    },
    {
      id: "windsurf",
      name: AGENTS.windsurf,
      hooks: { file: ".windsurf/hooks.json", json: { hooks: { pre_user_prompt: [{ command: hook() }], post_write_code: [{ command: hook() }] } } },
      mcp: { file: path.join(os.homedir(), ".codeium/windsurf/mcp_config.json"), user: true, json: { mcpServers: { breadth: stdio } } },
      notes: [],
    },
    {
      id: "antigravity",
      name: AGENTS.antigravity,
      hooks: {
        file: ".agents/hooks.json",
        json: { breadth: { PostToolUse: [{ matcher: "write_to_file|replace_file_content|multi_replace_file_content", hooks: [cmd()] }] } },
      },
      mcp: {
        file: path.join(os.homedir(), ".gemini/antigravity/mcp_config.json"),
        user: true,
        json: { mcpServers: { breadth: stdio } },
        note: "or paste it in Agent panel › MCP servers › Manage › View raw config",
      },
      notes: ["Antigravity has no prompt hook: its tasks reach the feed when the agent calls the breadth MCP tool `breadth_report_task`."],
    },
    {
      id: "codex",
      name: AGENTS.codex,
      hooks: {
        file: ".codex/hooks.json",
        json: {
          hooks: {
            UserPromptSubmit: [{ hooks: [{ ...cmd(AGENTS.codex), timeout: 5 }] }],
            PostToolUse: [{ matcher: "apply_patch|Edit|Write", hooks: [{ ...cmd(AGENTS.codex), timeout: 5 }] }],
          },
        },
      },
      mcp: {
        file: ".codex/config.toml",
        toml: `[mcp_servers.breadth]\ncommand = ${JSON.stringify(stdio.command)}\nargs = ${JSON.stringify(stdio.args)}\n`,
      },
      notes: ["Codex asks you to trust new hooks: run /hooks in Codex once after connecting."],
    },
  ];
}

/** Our hook and MCP entries are recognised by this, so connecting twice replaces instead of duplicating. */
const OURS = /\bbreadth(\.mjs)?"?\s+(hook|mcp)\b/;

function commandsIn(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => commandsIn(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) k === "command" && typeof x === "string" ? out.add(x) : commandsIn(x, out);
  return out;
}

/** Deep-merge `add` into `base`: objects merge, arrays drop our old entries and append the new ones. */
export function mergeConfig(base: unknown, add: unknown, ours = commandsIn(add)): unknown {
  const isOurs = (entry: unknown) => {
    const text = JSON.stringify(entry ?? "");
    return OURS.test(text) || [...commandsIn(entry)].some((c) => ours.has(c));
  };
  if (Array.isArray(add)) return [...(Array.isArray(base) ? base.filter((x) => !isOurs(x)) : []), ...add];
  if (add && typeof add === "object") {
    const out: Record<string, unknown> = base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
    for (const [k, v] of Object.entries(add)) out[k] = mergeConfig(out[k], v, ours);
    return out;
  }
  return add;
}

export interface WriteResult {
  file: string;
  status: "written" | "unchanged" | "skipped";
  reason?: string;
}

export function writeConfig(dir: string, cf: ConfigFile): WriteResult {
  const file = path.isAbsolute(cf.file) ? cf.file : path.join(dir, cf.file);
  if (cf.user) return { file, status: "skipped", reason: "user-level file: add it yourself" };
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  let after: string;
  if (cf.toml) {
    if (before?.includes("[mcp_servers.breadth]")) return { file, status: "unchanged" };
    after = (before ? before.replace(/\n*$/, "\n\n") : "") + cf.toml;
  } else {
    let parsed: unknown = {};
    if (before?.trim()) {
      try {
        parsed = JSON.parse(before);
      } catch {
        return { file, status: "skipped", reason: "not plain JSON (comments?): merge the snippet by hand" };
      }
    }
    after = JSON.stringify(mergeConfig(parsed, cf.json), null, 2) + "\n";
  }
  if (after === before) return { file, status: "unchanged" };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, after);
  return { file, status: "written" };
}

export function renderConfig(cf: ConfigFile): string {
  const body = cf.toml ?? JSON.stringify(cf.json, null, 2);
  return `${cf.file}${cf.note ? `  (${cf.note})` : ""}\n${body.replace(/^/gm, "  ")}\n`;
}
