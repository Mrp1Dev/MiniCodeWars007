// Web Worker that runs Python (Pyodide) off the main thread, so a slow bot can't freeze the page.
// Messages: {id, type: "init" | "check" | "test", ...} -> {id, ok, result | error}
import DRIVER from "./driver.py?raw";

let checkFn = null;
let testFn = null;

async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

async function init(base) {
  const indexURL = new URL(base, self.location.origin).href;
  const { loadPyodide } = await import(/* @vite-ignore */ indexURL + "pyodide.mjs");
  const [py, bundle, bots] = await Promise.all([
    loadPyodide({ indexURL }),
    getJSON("/api/engine-bundle"),
    getJSON("/api/house-bots"),
  ]);
  py.FS.mkdirTree("/mcw/engine");
  for (const [path, source] of Object.entries(bundle.files)) py.FS.writeFile("/mcw/" + path, source);
  py.globals.set("CONFIG_JSON", JSON.stringify(bundle.config));
  py.globals.set("BOTS_JSON", JSON.stringify(bots));
  py.runPython(DRIVER);
  checkFn = py.globals.get("check_json");
  testFn = py.globals.get("test_json");
  return true;
}

self.onmessage = async (event) => {
  const { id, type } = event.data;
  try {
    let result;
    if (type === "init") result = await init(event.data.base);
    else if (type === "check") result = JSON.parse(checkFn(event.data.code));
    else if (type === "test") result = JSON.parse(testFn(event.data.code, event.data.opponent, event.data.seed));
    else throw new Error(`unknown message ${type}`);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
