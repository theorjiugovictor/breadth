import type { FlowGraph } from "@noodles/schema";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface CollectorOptions {
  /** Extra glob-ish patterns (gitignore syntax) to skip. */
  exclude?: string[];
  /** If set, only paths matching these patterns (gitignore syntax) are scanned. */
  include?: string[];
  /** Collector-specific settings from the config file, keyed by collector name. */
  settings?: Record<string, unknown>;
  log?: Logger;
  /**
   * Unsaved editor contents by absolute path (live mode). Collectors read these instead of
   * the file on disk, so edits show up before they are saved.
   */
  overlay?: Map<string, string>;
}

/**
 * A collector turns some target (a directory, a file) into a flowgraph.
 * It must emit stable ids so repeated runs and other collectors merge cleanly.
 */
export interface Collector {
  name: string;
  description: string;
  /** Stub collectors are listed but never auto-selected. */
  implemented: boolean;
  /** Cheap check used for zero-config auto-selection. */
  detect(target: string, options?: CollectorOptions): Promise<boolean>;
  collect(target: string, options: CollectorOptions): Promise<FlowGraph>;
}

export const silentLogger: Logger = { info() {}, warn() {} };
