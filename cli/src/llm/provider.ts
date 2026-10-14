import type { FlowGraph, FlowNode } from "@breadth/schema";

/**
 * The single seam for optional LLM features: node summaries, "explain this", and live
 * narration of what a coding agent changed. Off by default. Nothing is sent anywhere
 * unless a provider is configured, and remote providers are announced before use.
 */
export interface LLMProvider {
  /** e.g. "anthropic:claude-opus-5-5", "ollama:llama3.2" */
  name: string;
  /** True when requests leave this machine. */
  remote: boolean;
  complete(req: CompleteRequest): Promise<string | undefined>;
}

export interface CompleteRequest {
  system: string;
  prompt: string;
  /** Upper bound for the answer (providers with built-in reasoning get extra room). */
  maxTokens?: number;
}

export interface LLMSettings {
  /** none (default) | anthropic | openai | gemini | ollama | openai-compatible | a preset (see PRESETS) */
  provider?: string;
  model?: string;
  /** Override the endpoint (gateways, proxies, self-hosted servers). */
  baseUrl?: string;
  /** Name of the environment variable holding the API key (defaults per provider). */
  apiKeyEnv?: string;
  /** Extra HTTP headers, e.g. {"api-key": "..."} for Azure-style gateways. Values may be "$ENV_VAR". */
  headers?: Record<string, string>;
  /** Max nodes to summarise per scan. */
  limit?: number;
}

interface Preset {
  kind: "openai" | "anthropic" | "gemini" | "ollama";
  baseUrl: string;
  keyEnv?: string;
  /** Only where the default is stable; otherwise `model` is required. */
  defaultModel?: string;
  label: string;
}

/** Providers that speak one of four wire formats. Anything OpenAI-compatible works via baseUrl. */
export const PRESETS: Record<string, Preset> = {
  anthropic: { kind: "anthropic", baseUrl: "https://api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-opus-5-5", label: "Anthropic (Claude)" },
  openai: { kind: "openai", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", label: "OpenAI" },
  gemini: { kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", keyEnv: "GEMINI_API_KEY", label: "Google Gemini" },
  ollama: { kind: "ollama", baseUrl: "http://127.0.0.1:11434", defaultModel: "llama3.2", label: "Ollama (local)" },
  openrouter: { kind: "openai", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", label: "OpenRouter" },
  groq: { kind: "openai", baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", label: "Groq" },
  together: { kind: "openai", baseUrl: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY", label: "Together AI" },
  mistral: { kind: "openai", baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY", label: "Mistral" },
  deepseek: { kind: "openai", baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY", label: "DeepSeek" },
  xai: { kind: "openai", baseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY", label: "xAI" },
  fireworks: { kind: "openai", baseUrl: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY", label: "Fireworks" },
  lmstudio: { kind: "openai", baseUrl: "http://127.0.0.1:1234/v1", label: "LM Studio (local)" },
  vllm: { kind: "openai", baseUrl: "http://127.0.0.1:8000/v1", label: "vLLM (local)" },
  llamacpp: { kind: "openai", baseUrl: "http://127.0.0.1:8080/v1", label: "llama.cpp server (local)" },
  "openai-compatible": { kind: "openai", baseUrl: "", keyEnv: "OPENAI_API_KEY", label: "Any OpenAI-compatible endpoint (set baseUrl)" },
};

export const noneProvider: LLMProvider = {
  name: "none",
  remote: false,
  async complete() {
    return undefined;
  },
};

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

function resolveHeaders(h?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k] = v.startsWith("$") ? (process.env[v.slice(1)] ?? "") : v;
  return out;
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`${new URL(url).host} returned ${res.status}: ${text}`);
  }
  return res.json();
}

function anthropicProvider(model: string, s: LLMSettings, keyEnv: string): LLMProvider {
  const baseURL = s.baseUrl;
  let client: import("@anthropic-ai/sdk").default | undefined;
  return {
    name: `anthropic:${model}`,
    remote: !baseURL || !isLoopback(baseURL),
    async complete({ system, prompt, maxTokens }) {
      // Loaded lazily so the CLI starts fast when LLM features are off.
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      // Credentials: an explicit apiKeyEnv, else the SDK's own resolution
      // (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
      client ??= new Anthropic({ ...(s.apiKeyEnv ? { apiKey: process.env[keyEnv] } : {}), ...(baseURL ? { baseURL } : {}), defaultHeaders: resolveHeaders(s.headers) });
      const response = await client.beta.messages.create({
        model,
        // Room for adaptive thinking on top of a short answer.
        max_tokens: Math.max(4000, maxTokens ?? 0),
        system,
        messages: [{ role: "user", content: prompt }],
        // Short, routine summaries: low effort is plenty.
        output_config: { effort: "low" },
        // If a safety classifier declines, let the API re-run the request on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      if (response.stop_reason === "refusal") return undefined;
      return response.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
    },
  };
}

function openaiProvider(name: string, model: string, base: string, key: string | undefined, s: LLMSettings): LLMProvider {
  return {
    name: `${name}:${model}`,
    remote: !isLoopback(base),
    async complete({ system, prompt, maxTokens }) {
      const body = (await postJson(
        `${base.replace(/\/$/, "")}/chat/completions`,
        {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          max_tokens: maxTokens ?? 400,
        },
        { ...(key ? { authorization: `Bearer ${key}` } : {}), ...resolveHeaders(s.headers) },
      )) as { choices?: { message?: { content?: string } }[] };
      return body.choices?.[0]?.message?.content?.trim();
    },
  };
}

function geminiProvider(model: string, base: string, key: string | undefined, s: LLMSettings): LLMProvider {
  return {
    name: `gemini:${model}`,
    remote: !isLoopback(base),
    async complete({ system, prompt, maxTokens }) {
      const body = (await postJson(
        `${base.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent`,
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens ?? 400 },
        },
        { ...(key ? { "x-goog-api-key": key } : {}), ...resolveHeaders(s.headers) },
      )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return body.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .join("")
        .trim();
    },
  };
}

function ollamaProvider(model: string, base: string, s: LLMSettings): LLMProvider {
  return {
    name: `ollama:${model}`,
    remote: !isLoopback(base),
    async complete({ system, prompt, maxTokens }) {
      const body = (await postJson(
        `${base.replace(/\/$/, "")}/api/chat`,
        {
          model,
          stream: false,
          options: { num_predict: maxTokens ?? 400 },
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        },
        resolveHeaders(s.headers),
      )) as { message?: { content?: string } };
      return body.message?.content?.trim();
    },
  };
}

/** Settings from config, then environment, then CLI flags (later wins). */
export function resolveSettings(config: LLMSettings | undefined, flags: { provider?: string; model?: string; baseUrl?: string } = {}): LLMSettings {
  const env = process.env;
  return {
    ...(config ?? {}),
    ...(env.BREADTH_LLM_PROVIDER ? { provider: env.BREADTH_LLM_PROVIDER } : {}),
    ...(env.BREADTH_LLM_MODEL ? { model: env.BREADTH_LLM_MODEL } : {}),
    ...(env.BREADTH_LLM_BASE_URL ? { baseUrl: env.BREADTH_LLM_BASE_URL } : {}),
    ...(flags.provider ? { provider: flags.provider } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.baseUrl ? { baseUrl: flags.baseUrl } : {}),
  };
}

export function createProvider(settings: LLMSettings | undefined): LLMProvider {
  const id = (settings?.provider ?? "none").toLowerCase();
  if (id === "none") return noneProvider;
  const preset = PRESETS[id];
  if (!preset) throw new Error(`unknown LLM provider "${settings?.provider}". Known: none, ${Object.keys(PRESETS).join(", ")}`);
  const s = settings!;
  const model = s.model ?? preset.defaultModel;
  if (!model) throw new Error(`LLM provider "${id}" needs a model: set "llm": {"model": "..."} in breadth.config.json, BREADTH_LLM_MODEL, or --llm-model`);
  const base = s.baseUrl ?? preset.baseUrl;
  if (!base) throw new Error(`LLM provider "${id}" needs a baseUrl (the OpenAI-compatible endpoint, e.g. http://localhost:4000/v1)`);
  const keyEnv = s.apiKeyEnv ?? preset.keyEnv ?? "";
  const key = keyEnv ? process.env[keyEnv] : undefined;
  switch (preset.kind) {
    case "anthropic":
      return anthropicProvider(model, s, keyEnv);
    case "openai":
      if (!key && preset.keyEnv && !isLoopback(base)) throw new Error(`LLM provider "${id}" needs an API key in $${keyEnv}`);
      return openaiProvider(id, model, base, key, s);
    case "gemini":
      if (!key) throw new Error(`LLM provider "gemini" needs an API key in $${keyEnv}`);
      return geminiProvider(model, base, key, s);
    case "ollama":
      return ollamaProvider(model, base, s);
  }
}

/** One line telling the user where code excerpts are about to go. */
export function privacyNotice(p: LLMProvider, what: string): string | undefined {
  if (p === noneProvider) return undefined;
  return p.remote ? `llm: sending ${what} to ${p.name} (leaves this machine)` : `llm: using local model ${p.name} for ${what}`;
}

const SUMMARY_SYSTEM =
  "You describe code for a visual map of a software system. Reply with one plain sentence of at most 20 words saying what the given function, class or module does. No preamble, no markdown.";

/** Fill in missing descriptions for the most connected functions/modules. */
export async function summarizeGraph(
  graph: FlowGraph,
  provider: LLMProvider,
  readSource: (file: string, start: number, end: number) => string | undefined,
  limit = 50,
): Promise<number> {
  if (provider === noneProvider) return 0;
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.from.node, (degree.get(e.from.node) ?? 0) + 1);
    degree.set(e.to.node, (degree.get(e.to.node) ?? 0) + 1);
  }
  const candidates = graph.nodes
    .filter((n) => !n.description && n.source?.file && n.source.line && (n.kind === "function" || n.kind === "module"))
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, limit);
  let done = 0;
  for (const n of candidates) {
    const src = readSource(n.source!.file!, n.source!.line!, Math.min(n.source!.endLine ?? n.source!.line! + 40, n.source!.line! + 120));
    if (!src) continue;
    const text = await provider.complete({ system: SUMMARY_SYSTEM, prompt: `${n.kind} ${n.name} in ${n.source!.file}:\n\n${src}`, maxTokens: 80 });
    if (text) {
      n.description = text.split("\n")[0];
      n.metadata = { ...(n.metadata ?? {}), descriptionBy: provider.name };
      done++;
    }
  }
  return done;
}

/** Context for "explain this node": its code, what calls it, what it calls, related findings. */
export function explainPrompt(graph: FlowGraph, node: FlowNode, source: string | undefined): string {
  const name = (id: string) => graph.nodes.find((n) => n.id === id)?.name ?? id;
  const incoming = graph.edges.filter((e) => e.to.node === node.id).slice(0, 15);
  const outgoing = graph.edges.filter((e) => e.from.node === node.id).slice(0, 15);
  const insights = (graph.insights ?? []).filter((i) => i.nodes.includes(node.id)).slice(0, 5);
  const lines = [
    `${node.kind} "${node.name}" (${node.id})`,
    node.description ? `Description: ${node.description}` : "",
    node.inputs?.length ? `Inputs: ${node.inputs.map((p) => `${p.name}${p.type ? `: ${p.type}` : ""}`).join(", ")}` : "",
    node.outputs?.length ? `Outputs: ${node.outputs.map((p) => `${p.name}${p.type ? `: ${p.type}` : ""}`).join(", ")}` : "",
    incoming.length ? `Called/used by: ${incoming.map((e) => `${name(e.from.node)} (${e.kind}${e.label ? ` ${e.label}` : ""})`).join("; ")}` : "",
    outgoing.length ? `Calls/uses: ${outgoing.map((e) => `${name(e.to.node)} (${e.kind}${e.label ? ` ${e.label}` : ""})`).join("; ")}` : "",
    insights.length ? `Findings: ${insights.map((i) => `${i.title}. ${i.detail ?? ""}`).join(" | ")}` : "",
    source ? `\nSource:\n${source}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export const EXPLAIN_SYSTEM =
  "You explain one part of a software system to a developer looking at a map of it. In at most 120 words: what it does, what flows in and out, and anything risky or worth improving (mention the listed findings if any, with a concrete fix). Plain text, short paragraphs, no headings.";
