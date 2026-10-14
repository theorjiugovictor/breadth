import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider, noneProvider, resolveSettings } from "./llm/provider.js";
import { hookPayload, hookReply } from "./hook.js";
import { integrations, writeConfig } from "./connect.js";
import { runMcp } from "./mcp.js";
import { LiveSession, type ActivityEntry } from "./live.js";

let dir: string | undefined;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("LLM providers", () => {
  it("is off by default", () => {
    expect(createProvider(undefined)).toBe(noneProvider);
    expect(createProvider({ provider: "none" })).toBe(noneProvider);
  });

  it("layers config, environment and flags", () => {
    vi.stubEnv("NOODLES_LLM_PROVIDER", "groq");
    vi.stubEnv("NOODLES_LLM_MODEL", "env-model");
    const s = resolveSettings({ provider: "openai", model: "cfg", limit: 5 }, { model: "flag-model" });
    expect(s).toMatchObject({ provider: "groq", model: "flag-model", limit: 5 });
  });

  it("explains what is missing", () => {
    expect(() => createProvider({ provider: "nope" })).toThrow(/unknown LLM provider/);
    expect(() => createProvider({ provider: "openai" })).toThrow(/needs a model/);
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(() => createProvider({ provider: "openai", model: "m" })).toThrow(/OPENAI_API_KEY/);
    expect(() => createProvider({ provider: "openai-compatible", model: "m" })).toThrow(/baseUrl/);
  });

  it("treats loopback endpoints as local and needs no key for them", () => {
    const p = createProvider({ provider: "openai-compatible", model: "m", baseUrl: "http://localhost:4000/v1" });
    expect(p.remote).toBe(false);
    expect(createProvider({ provider: "ollama" }).remote).toBe(false);
    expect(createProvider({ provider: "anthropic" }).name).toBe("anthropic:claude-opus-5-5");
  });

  it("speaks the OpenAI, Gemini and Ollama wire formats", async () => {
    const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
    const answers = [
      { choices: [{ message: { content: " openai says hi " } }] },
      { candidates: [{ content: { parts: [{ text: "gemini" }, { text: " says hi" }] } }] },
      { message: { content: "ollama says hi" } },
    ];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify(answers[calls.length - 1]), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubEnv("GROQ_API_KEY", "gk");
    vi.stubEnv("GEMINI_API_KEY", "gm");
    const req = { system: "sys", prompt: "hi" };
    expect(await createProvider({ provider: "groq", model: "llama" }).complete(req)).toBe("openai says hi");
    expect(await createProvider({ provider: "gemini", model: "gemini-x" }).complete(req)).toBe("gemini says hi");
    expect(await createProvider({ provider: "ollama" }).complete(req)).toBe("ollama says hi");
    expect(calls[0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(calls[0].headers.authorization).toBe("Bearer gk");
    expect(calls[0].body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(calls[1].url).toContain("/models/gemini-x:generateContent");
    expect(calls[1].headers["x-goog-api-key"]).toBe("gm");
    expect(calls[2].url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls[2].body.stream).toBe(false);
  });
});

describe("hookPayload", () => {
  const claudeEnv = { CLAUDE_PROJECT_DIR: "/w" };
  it("maps Claude Code hook JSON", () => {
    expect(hookPayload({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/w/a.py" }, session_id: "s" }, undefined, claudeEnv)).toEqual({
      agent: "Claude Code",
      event: "PostToolUse",
      tool: "Edit",
      files: ["/w/a.py"],
      prompt: undefined,
      session: "s",
    });
    expect(hookPayload({ hook_event_name: "UserPromptSubmit", prompt: "add auth" }, undefined, claudeEnv)).toMatchObject({ agent: "Claude Code", prompt: "add auth" });
  });

  it("maps Copilot in VS Code (Claude format, camelCase tool input)", () => {
    const p = hookPayload({ hook_event_name: "PostToolUse", tool_name: "replace_string_in_file", tool_input: { filePath: "src/a.ts" }, cwd: "/w" }, undefined, {});
    expect(p).toMatchObject({ agent: "Copilot", files: ["/w/src/a.ts"] });
    expect(hookPayload({ hook_event_name: "PostToolUse", tool_name: "editFiles", tool_input: { files: ["/w/x.ts", "/w/y.ts"] } }, undefined, {}).files).toEqual(["/w/x.ts", "/w/y.ts"]);
    // VS Code ignores matchers, so read-only tools arrive too: they touch nothing.
    expect(hookPayload({ hook_event_name: "PostToolUse", tool_name: "read_file", tool_input: { filePath: "/w/a.ts" } }, undefined, {}).files).toEqual([]);
  });

  it("maps Cursor", () => {
    const edit = hookPayload({ hook_event_name: "afterFileEdit", cursor_version: "2.3", file_path: "/w/a.py", edits: [{ old_string: "", new_string: "x" }], conversation_id: "c" });
    expect(edit).toMatchObject({ agent: "Cursor", files: ["/w/a.py"], session: "c" });
    expect(hookPayload({ hook_event_name: "beforeSubmitPrompt", cursor_version: "2.3", prompt: "go" })).toMatchObject({ agent: "Cursor", prompt: "go" });
    expect(hookReply({ hook_event_name: "beforeSubmitPrompt", cursor_version: "2.3" })).toBe('{"continue":true}\n');
  });

  it("maps Gemini CLI", () => {
    const raw = { hook_event_name: "AfterTool", tool_name: "write_file", tool_input: { file_path: "a.py", content: "x" }, cwd: "/w" };
    expect(hookPayload(raw, undefined, {})).toMatchObject({ agent: "Gemini CLI", files: ["/w/a.py"] });
    expect(hookPayload({ hook_event_name: "BeforeAgent", prompt: "fix it" }, undefined, {})).toMatchObject({ agent: "Gemini CLI", prompt: "fix it" });
    expect(hookReply(raw, undefined, {})).toBe("{}\n");
  });

  it("maps Windsurf", () => {
    expect(hookPayload({ agent_action_name: "post_write_code", trajectory_id: "t", tool_info: { file_path: "/w/a.py", edits: [] } })).toMatchObject({
      agent: "Windsurf",
      event: "post_write_code",
      files: ["/w/a.py"],
      session: "t",
    });
    expect(hookPayload({ agent_action_name: "pre_user_prompt", tool_info: { user_prompt: "hello" } }).prompt).toBe("hello");
  });

  it("maps Antigravity", () => {
    const p = hookPayload({ toolCall: { name: "replace_file_content", args: { TargetFile: "/w/a.ts", ReplacementContent: "x" } }, workspacePaths: ["/w"], conversationId: "c", stepIdx: 3 });
    expect(p).toMatchObject({ agent: "Antigravity", tool: "replace_file_content", files: ["/w/a.ts"], session: "c" });
    expect(hookReply({ stepIdx: 3, workspacePaths: ["/w"] })).toBe("{}\n");
  });

  it("maps Codex apply_patch edits", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.py\n@@\n-x\n+y\n*** Add File: src/b.py\n+z\n*** End Patch";
    const p = hookPayload({ hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command: patch }, cwd: "/w" }, undefined, {});
    expect(p).toMatchObject({ agent: "Codex", files: ["/w/src/a.py", "/w/src/b.py"] });
    expect(hookReply({ hook_event_name: "UserPromptSubmit" }, "Codex")).toBe("");
  });

  it("accepts a plain payload from other agents", () => {
    expect(hookPayload({ files: ["x.ts"], agent: "Aider" })).toMatchObject({ agent: "Aider", files: ["x.ts"] });
    expect(hookPayload({ files: ["x.ts"] }, "Cursor").agent).toBe("Cursor");
  });
});

describe("connect", () => {
  it("merges hooks idempotently and keeps the user's own", () => {
    dir = mkdtempSync(path.join(tmpdir(), "noodles-connect-"));
    const claude = integrations().find((i) => i.id === "claude")!;
    mkdirSync(path.join(dir, ".claude"));
    writeFileSync(path.join(dir, ".claude/settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint" }] }] }, model: "x" }));
    expect(writeConfig(dir, claude.hooks).status).toBe("written");
    expect(writeConfig(dir, claude.hooks).status).toBe("unchanged");
    const s = JSON.parse(readFileSync(path.join(dir, ".claude/settings.json"), "utf8"));
    expect(s.model).toBe("x");
    expect(s.hooks.PostToolUse).toHaveLength(2);
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/hook$/);
    const codex = integrations().find((i) => i.id === "codex")!;
    expect(writeConfig(dir, codex.mcp).status).toBe("written");
    expect(writeConfig(dir, codex.mcp).status).toBe("unchanged");
    expect(readFileSync(path.join(dir, ".codex/config.toml"), "utf8")).toContain("[mcp_servers.noodles]");
  });

  it("never writes user-level files or JSON with comments", () => {
    dir = mkdtempSync(path.join(tmpdir(), "noodles-connect-"));
    const windsurf = integrations().find((i) => i.id === "windsurf")!;
    expect(writeConfig(dir, windsurf.mcp).status).toBe("skipped");
    mkdirSync(path.join(dir, ".vscode"));
    writeFileSync(path.join(dir, ".vscode/mcp.json"), "// mine\n{}");
    expect(writeConfig(dir, integrations().find((i) => i.id === "copilot")!.mcp).status).toBe("skipped");
  });
});

describe("mcp", () => {
  it("answers initialize, lists tools and runs them on a scanned folder", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "noodles-mcp-"));
    writeFileSync(path.join(dir, "app.py"), "def load(x):\n    return parse(x)\n\ndef parse(x):\n    return x\n");
    const input = new PassThrough();
    const lines: any[] = [];
    const done = runMcp({ root: dir, port: "1", version: "t", input, output: { write: (c: string) => lines.push(JSON.parse(c)) } });
    const send = (m: object) => input.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    send({ id: 3, method: "tools/call", params: { name: "noodles_impact", arguments: { node: "parse" } } });
    send({ id: 4, method: "tools/call", params: { name: "noodles_report_task", arguments: { summary: "x" } } });
    send({ id: 6, method: "tools/call", params: { name: "noodles_find", arguments: { query: "pars" } } });
    send({ id: 5, method: "nope" });
    input.end();
    await done;
    const byId = new Map(lines.map((l) => [l.id, l]));
    expect(byId.get(1).result.serverInfo.name).toBe("noodles");
    expect(byId.get(2).result.tools.map((t: any) => t.name)).toContain("noodles_report_task");
    expect(byId.get(3).result.content[0].text).toContain("load");
    expect(byId.get(4).result.content[0].text).toMatch(/not running/);
    expect(byId.get(5).error.code).toBe(-32601);
    expect(byId.get(6).result.content[0].text.split("\n")).toEqual([expect.stringContaining("- parse (function) app.py:4")]);
    expect(lines).toHaveLength(6);
  });
});

describe("LiveSession", () => {

  it("rescans and reports what an agent changed", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "noodles-live-"));
    writeFileSync(path.join(dir, "app.py"), "def a():\n    return 1\n");
    const live = new LiveSession({ target: dir, collectorOptions: {} });
    await live.start();
    try {
      expect(live.graph.nodes.some((n) => n.name === "a")).toBe(true);
      live.agentActivity({ agent: "Claude Code", prompt: "add b" });
      writeFileSync(path.join(dir, "app.py"), "def a():\n    return b()\n\ndef b():\n    return 2\n");
      live.agentActivity({ agent: "Claude Code", files: [path.join(dir, "app.py")] });
      await live.rescan();
      const change = live.activity.find((a) => a.kind === "change") as ActivityEntry;
      expect(live.activity[0]).toMatchObject({ kind: "task", prompt: "add b" });
      expect(change.agent).toBe("Claude Code");
      expect(change.files).toContain("app.py");
      expect(change.added?.map((r) => r.name)).toContain("b");
      expect(live.version).toBeGreaterThan(1);

      // Unsaved editor text is scanned before it reaches the disk, and dropped once saved.
      live.setBuffers([{ path: path.join(dir, "app.py"), text: "def a():\n    return 1\n\ndef c():\n    return 3\n" }]);
      await live.rescan();
      expect(live.graph.nodes.map((n) => n.name)).toEqual(expect.arrayContaining(["a", "c"]));
      expect(live.graph.nodes.some((n) => n.name === "b")).toBe(false);
      live.setBuffers([{ path: path.join(dir, "app.py"), text: null }]);
      await live.rescan();
      expect(live.graph.nodes.some((n) => n.name === "b")).toBe(true);
      // An edit to a file the agent never touched is not credited to it.
      writeFileSync(path.join(dir, "other.py"), "def z():\n    return 0\n");
      live.agentActivity({ agent: "Claude Code", files: [path.join(dir, "app.py")] });
      await live.rescan();
      live.setBuffers([{ path: path.join(dir, "other.py"), text: "def z():\n    return 0\n\ndef y():\n    return 1\n" }]);
      await live.rescan();
      const human = live.activity.filter((a) => a.kind === "change").pop()!;
      expect(human.added?.map((r) => r.name)).toContain("y");
      expect(human.agent).toBeUndefined();
      // Paths outside the project are ignored.
      live.setBuffers([{ path: "/etc/passwd", text: "x" }]);

      // The same prompt from two hooks (VS Code runs Claude Code's too) shows once.
      live.agentActivity({ agent: "Copilot", prompt: "same" });
      live.agentActivity({ agent: "Claude Code", prompt: "same" });
      expect(live.activity.filter((a) => a.prompt === "same")).toHaveLength(1);
    } finally {
      live.stop();
    }
  });
});
