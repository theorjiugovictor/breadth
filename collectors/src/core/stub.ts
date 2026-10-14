import type { Collector } from "./types.js";

/** A listed-but-not-implemented collector. See the README next to each stub for the planned mapping. */
export function stubCollector(name: string, description: string): Collector {
  return {
    name,
    description: `${description} (not implemented yet)`,
    implemented: false,
    async detect() {
      return false;
    },
    async collect() {
      throw new Error(`collector "${name}" is a stub and is not implemented yet. See collectors/src/${name}/README.md`);
    },
  };
}
