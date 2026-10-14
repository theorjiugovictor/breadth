import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `--mode pages` builds the hosted demo (GitHub Pages) into ../site-dist/app.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: "./",
  // the in-browser repo scanner runs in a module worker (tree-sitter loads lazily)
  worker: { format: "es" },
  build: {
    outDir: mode === "pages" ? "../site-dist/app" : "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
  define: {
    __BREADTH_PAGES__: JSON.stringify(mode === "pages"),
  },
  server: { port: 5173 },
}));
