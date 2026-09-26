// Writes file.gz next to every compressible file in ../web. The server sends the .gz to
// browsers that accept gzip (Pyodide's wasm goes from ~9.6 MB to ~3 MB).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const EXTS = new Set([".html", ".js", ".mjs", ".css", ".json", ".wasm", ".zip", ".svg", ".map"]);
let before = 0, after = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    if (!EXTS.has(extname(name))) continue;
    const data = readFileSync(path);
    if (data.length < 1024) continue;
    const gz = gzipSync(data, { level: 9 });
    if (gz.length > data.length * 0.9) continue; // not worth it
    writeFileSync(path + ".gz", gz);
    before += data.length;
    after += gz.length;
  }
}

walk(out);
console.log(`gzip: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`);
