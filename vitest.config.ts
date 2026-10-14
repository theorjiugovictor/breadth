import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["schema/**/*.test.ts", "collectors/**/*.test.ts", "cli/**/*.test.ts", "ui/src/**/*.test.ts"],
    testTimeout: 30000,
  },
});
