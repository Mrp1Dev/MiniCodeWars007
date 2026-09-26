import { useState } from "react";
import { api, ApiError } from "../api";

export default function Register({ status, onDone }) {
  const [mode, setMode] = useState("register"); // register | token
  const [roll, setRoll] = useState("");
  const [name, setName] = useState("");
  const [token, setTokenText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState({});

  const closed = status && !["registration", "coding"].includes(status.phase);

  async function register(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setFields({});
    try {
      const r = await api("/api/register", { body: { roll, name }, token: null });
      onDone(r.token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("This roll number is already registered. If that's you, use \"I already registered\" below with your token, or ask an organiser to recover your session.");
      } else {
        setError(err.message);
        setFields(err.fields || {});
      }
    } finally {
      setBusy(false);
    }
  }

  async function restore(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const t = token.trim();
    try {
      await api("/api/me", { token: t });
      onDone(t);
    } catch (err) {
      setError(err.status === 401 ? "That token didn't work. Check you copied all of it, or ask an organiser for a new one." : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="register-page">
      <div className="register-card">
        <img src="/logo.png" alt="" className="register-logo" />
        <h1>
          <span className="accent">007</span> Code Wars
        </h1>
        <p className="muted">
          Write a bot that plays 007. Describe it in plain words, let the AI turn it into Python, test it, then
          submit it for the tournament.
        </p>

        {mode === "register" ? (
          <form onSubmit={register}>
            <label>
              Roll number
              <input
                autoFocus
                value={roll}
                onChange={(e) => setRoll(e.target.value)}
                placeholder="e.g. 25B0001"
                className={fields.roll ? "invalid" : ""}
                autoComplete="off"
              />
              {fields.roll && <span className="field-error">{fields.roll}</span>}
            </label>
            <label>
              Your name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Asha Verma"
                className={fields.name ? "invalid" : ""}
                autoComplete="off"
              />
              {fields.name && <span className="field-error">{fields.name}</span>}
            </label>
            {error && !Object.keys(fields).length && <div className="alert alert-error">{error}</div>}
            {closed && <div className="alert">Registration is closed right now ({status.phase} phase).</div>}
            <button className="btn btn-primary btn-big" disabled={busy || !roll.trim() || !name.trim()}>
              {busy ? "Registering…" : "Enter the arena →"}
            </button>
            <button type="button" className="link" onClick={() => { setMode("token"); setError(""); }}>
              I already registered (on another laptop or browser)
            </button>
          </form>
        ) : (
          <form onSubmit={restore}>
            <label>
              Your token
              <input
                autoFocus
                value={token}
                onChange={(e) => setTokenText(e.target.value)}
                placeholder="paste the token here"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <p className="muted small">
              You can find your token under your name (top right) on the laptop you registered on. Lost it? An
              organiser can give you a new one.
            </p>
            {error && <div className="alert alert-error">{error}</div>}
            <button className="btn btn-primary btn-big" disabled={busy || !token.trim()}>
              {busy ? "Checking…" : "Continue →"}
            </button>
            <button type="button" className="link" onClick={() => { setMode("register"); setError(""); }}>
              ← Register instead
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
