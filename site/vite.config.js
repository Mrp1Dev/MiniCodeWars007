import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const pyodideVersion = JSON.parse(readFileSync("node_modules/pyodide/package.json", "utf8")).version;

export default defineConfig({
  plugins: [react()],
  define: { __PYODIDE_VERSION__: JSON.stringify(pyodideVersion) },
  build: { outDir: "../web", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
  // `npm run dev` serves the site on :5173 and forwards the API to the Python server.
  server: { proxy: { "/api": "http://localhost:8000" } },
});
