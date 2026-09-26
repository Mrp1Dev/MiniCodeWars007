import { useEffect, useRef, useState } from "react";
import { api } from "./api";

const POLL_MS = 5000;

// Polls /api/status. The countdown uses the server's clock (ends_at - server_time, then ticks
// down locally), so a laptop with the wrong time still shows the right countdown.
export function useEventStatus() {
  const [status, setStatus] = useState(null);
  const [offline, setOffline] = useState(false);
  const refreshRef = useRef(() => {});

  useEffect(() => {
    let stop = false;
    let timer;
    async function poll() {
      clearTimeout(timer);
      try {
        const s = await api("/api/status", { token: null });
        if (stop) return;
        setStatus({ ...s, receivedAt: performance.now() });
        setOffline(false);
      } catch {
        if (!stop) setOffline(true);
      }
      if (!stop) timer = setTimeout(poll, POLL_MS);
    }
    refreshRef.current = poll;
    poll();
    return () => { stop = true; clearTimeout(timer); };
  }, []);

  return { status, offline, refresh: () => refreshRef.current() };
}

// Seconds left in the coding phase, or null when there's no timer.
export function useSecondsLeft(status) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  if (!status || status.phase !== "coding" || !status.ends_at) return null;
  const elapsed = (performance.now() - status.receivedAt) / 1000;
  return Math.max(0, status.ends_at - status.server_time - elapsed);
}

export function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function formatClock(seconds) {
  const s = Math.ceil(seconds);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
