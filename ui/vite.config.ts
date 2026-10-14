import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `--mode pages` builds the hosted demo (GitHub Pages) into ../site-dist/app.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: "./",
  build: {
    outDir: mode === "pages" ? "../site-dist/app" : "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
  define: {
    __NOODLES_PAGES__: JSON.stringify(mode === "pages"),
  },
  server: { port: 5173 },
}));
