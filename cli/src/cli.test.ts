import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider, noneProvider, resolveSettings } from "./llm/provider.js";
import { hookPayload } from "./hook.js";
import { LiveSession, type ActivityEntry } from "./live.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
  it("maps Claude Code hook JSON", () => {
    expect(hookPayload({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/w/a.py" }, session_id: "s" })).toEqual({
      agent: "Claude Code",
      event: "PostToolUse",
      tool: "Edit",
      files: ["/w/a.py"],
      prompt: undefined,
      session: "s",
    });
    expect(hookPayload({ hook_event_name: "UserPromptSubmit", prompt: "add auth" }).prompt).toBe("add auth");
  });

  it("accepts a plain payload from other agents", () => {
    expect(hookPayload({ files: ["x.ts"], agent: "Aider" })).toMatchObject({ agent: "Aider", files: ["x.ts"] });
    expect(hookPayload({ files: ["x.ts"] }, "Cursor").agent).toBe("Cursor");
  });
});

describe("LiveSession", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

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
    } finally {
      live.stop();
    }
  });
});
