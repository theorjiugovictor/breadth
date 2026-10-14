// Browser-safe entry point: no Node APIs. Used by the in-browser repo scanner.
export { scanSources, parseSource, type SourceFile, type ScanOptions } from "./code/scan.js";
export { setWasmLocator, langForFile, GRAMMAR_FILES, type WasmLocator } from "./code/parser.js";
export { SERVICE_MANIFESTS } from "./code/build.js";
export { DEFAULT_EXCLUDES } from "./core/excludes.js";
