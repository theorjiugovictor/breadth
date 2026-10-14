import type { FlowGraph, FlowNode } from "@noodles/schema";

/**
 * The single seam for optional LLM features (naming, summarising, grouping).
 * Off by default. Noodles never sends code anywhere unless a provider is configured.
 */
export interface LLMProvider {
  name: string;
  /** One-sentence summary of a node, given its source excerpt and neighbours. */
  summarize(input: { node: FlowNode; context: string }): Promise<string | undefined>;
}

export interface LLMSettings {
  /** 'none' (default) or 'ollama' (local model over http://localhost:11434). */
  provider?: "none" | "ollama";
  model?: string;
  url?: string;
  /** Max nodes to summarise per run. */
  limit?: number;
}

export const noneProvider: LLMProvider = {
  name: "none",
  async summarize() {
    return undefined;
  },
};

export function ollamaProvider(settings: LLMSettings): LLMProvider {
  const url = settings.url ?? "http://127.0.0.1:11434";
  const model = settings.model ?? "llama3.2";
  return {
    name: `ollama:${model}`,
    async summarize({ node, context }) {
      const prompt = `In one short sentence (max 20 words), describe what the ${node.kind} "${node.name}" does. Reply with the sentence only.\n\n${context.slice(0, 6000)}`;
      const res = await fetch(`${url}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt, stream: false }),
      });
      if (!res.ok) throw new Error(`ollama returned ${res.status}`);
      const body = (await res.json()) as { response?: string };
      return body.response?.trim().split("\n")[0];
    },
  };
}

export function createProvider(settings: LLMSettings | undefined): LLMProvider {
  switch (settings?.provider ?? "none") {
    case "none":
      return noneProvider;
    case "ollama":
      return ollamaProvider(settings!);
    default:
      throw new Error(`unknown LLM provider "${settings?.provider}" (supported: none, ollama)`);
  }
}

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
    const src = readSource(n.source!.file!, n.source!.line!, n.source!.endLine ?? n.source!.line! + 40);
    if (!src) continue;
    const text = await provider.summarize({ node: n, context: src });
    if (text) {
      n.description = text;
      n.metadata = { ...(n.metadata ?? {}), descriptionBy: provider.name };
      done++;
    }
  }
  return done;
}
