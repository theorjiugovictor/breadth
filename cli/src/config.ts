import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { LLMSettings } from "./llm/provider.js";

/** Optional breadth.config.json. Everything works without it. */
export interface BreadthConfig {
  collectors?: string[];
  include?: string[];
  exclude?: string[];
  /** Per-collector settings, keyed by collector name. */
  settings?: Record<string, unknown>;
  llm?: LLMSettings;
  /** Live observability backends for `breadth pull`, `watch --live`, `diff --live` and evidence. */
  sources?: import("./sources/index.js").SourcesConfig;
}

export const CONFIG_FILE = "breadth.config.json";

export function loadConfig(target: string, explicit?: string): BreadthConfig {
  const file = explicit ?? path.join(target, CONFIG_FILE);
  if (!existsSync(file)) {
    if (explicit) throw new Error(`config file not found: ${explicit}`);
    return {};
  }
  try {
    return JSON.parse(readFileSync(file, "utf8")) as BreadthConfig;
  } catch (err) {
    throw new Error(`could not read ${file}: ${(err as Error).message}`);
  }
}
