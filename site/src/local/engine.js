// The in-browser game engine: Pyodide in a Web Worker. It downloads in the background when the
// page opens; until it's ready (or if it fails), tests go to the server instead.
import { useSyncExternalStore } from "react";

const BASE = `/pyodide/${__PYODIDE_VERSION__}/`;
const MATCH_TIMEOUT_MS = 8000; // a whole match; more than this means an endless loop
const CHECK_TIMEOUT_MS = 3000;

let worker = null;
let nextId = 1;
const pending = new Map();
let state = { status: "idle", error: "" }; // idle | loading | ready | failed
const listeners = new Set();

function setState(next) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

export class EngineTimeout extends Error {}

function call(type, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = timeoutMs
      ? setTimeout(() => {
          pending.delete(id);
          reject(new EngineTimeout("took too long"));
          restart(); // the worker is stuck running Python; the only way out is to kill it
        }, timeoutMs)
      : null;
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, type, ...payload });
  });
}

function onMessage(event) {
  const { id, ok, result, error } = event.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  ok ? p.resolve(result) : p.reject(new Error(error));
}

function failAll(message) {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(message));
  }
  pending.clear();
}

export function startEngine() {
  if (worker) return;
  setState({ status: "loading", error: "" });
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = onMessage;
  worker.onerror = (e) => {
    failAll("the local engine crashed");
    setState({ status: "failed", error: e.message || "worker error" });
  };
  call("init", { base: BASE }, 0).then(
    () => setState({ status: "ready" }),
    (e) => {
      console.warn("local engine failed to load:", e);
      stopEngine();
      setState({ status: "failed", error: String(e.message || e) });
    },
  );
}

function stopEngine() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  failAll("the local engine was restarted");
}

function restart() {
  stopEngine();
  startEngine(); // Pyodide is cached by now, so this takes a few seconds
}

export const engineReady = () => state.status === "ready";

export function useEngineStatus() {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => state,
  );
}

export const checkLocally = (code) => call("check", { code }, CHECK_TIMEOUT_MS);
export const testLocally = (code, opponent, seed) => call("test", { code, opponent, seed }, MATCH_TIMEOUT_MS);
