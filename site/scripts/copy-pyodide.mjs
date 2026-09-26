// Copies the Pyodide runtime into public/pyodide/<version>/, so the site serves it itself
// (no CDN: 400 laptops on event Wi-Fi shouldn't depend on the internet).
// The version is in the path, so browsers can cache it forever.
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pyodide");
const { version } = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
const dest = join(root, "public", "pyodide", version);
const FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];

if (!existsSync(join(dest, FILES.at(-1)))) {
  mkdirSync(dest, { recursive: true });
  for (const f of FILES) cpSync(join(src, f), join(dest, f));
  console.log(`copied Pyodide ${version} to public/pyodide/${version}`);
}
