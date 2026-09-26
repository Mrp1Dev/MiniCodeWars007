// Sign in: roll number + name. A new roll number registers; a known one signs straight back in.
import { useState } from "react";
import { api } from "../api";
import { IconSend } from "./icons";

export default function Register({ status, onDone }) {
  const [roll, setRoll] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState({});

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setFields({});
    try {
      const r = await api("/api/register", { body: { roll, name }, token: null });
      onDone(r.token);
    } catch (err) {
      setError(err.message);
      setFields(err.fields || {});
    } finally {
      setBusy(false);
    }
  }

  const phase = status ? status.phase : null;

  return (
    <div className="signin">
      <div className="signin-rings" aria-hidden="true" />
      <div className="signin-inner">
        <img src="/logo.png" alt="WnCC" className="signin-logo" />
        <div className="signin-title">
          <span className="signin-007">007</span>
          <span className="signin-sub">Code Wars</span>
        </div>
        <p className="signin-lede">
          Write a bot. Five moves, three lives, one winner. Test it against our practice bots, then send it into the
          tournament.
        </p>

        <form onSubmit={submit} className="signin-form" noValidate>
          <label className="field">
            <span>Roll number</span>
            <input autoFocus value={roll} onChange={(e) => setRoll(e.target.value)} placeholder="25B0001"
              className={fields.roll ? "invalid" : ""} autoComplete="off" spellCheck={false} />
            {fields.roll && <em>{fields.roll}</em>}
          </label>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name"
              className={fields.name ? "invalid" : ""} autoComplete="off" />
            {fields.name && <em>{fields.name}</em>}
          </label>
          {error && !Object.keys(fields).length && <div className="note note-bad">{error}</div>}
          <button className="btn btn-gold btn-block" disabled={busy || !roll.trim() || !name.trim()}>
            {busy ? <span className="spinner" /> : null}
            {busy ? "Signing in" : "Enter"}
            {!busy && <IconSend />}
          </button>
          <p className="signin-hint">
            Switching laptops? Sign in with the same roll number; your submitted bot comes with you.
            {phase && !["registration", "coding"].includes(phase) && " New sign-ups are closed right now."}
          </p>
        </form>
      </div>
    </div>
  );
}
