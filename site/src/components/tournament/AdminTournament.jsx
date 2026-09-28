import React, { useCallback, useEffect, useState } from "react";
import { adminApi } from "../../api";
import { IconAlert, IconCheck, IconPlay, IconRefresh } from "../icons";

export default function AdminTournament({ notify, eventPhase }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [stepping, setStepping] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const res = await adminApi("/api/tournament/screen");
      setData(res);
    } catch (err) {
      console.error("Failed to load tournament data:", err);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 2000);
    return () => clearInterval(interval);
  }, [loadData]);

  const status = data?.status || {};
  const stage = status.stage || "ready_room";
  const paused = status.paused || false;
  const turnStep = status.turn_step ?? -1;
  // The server only launches rounds in the Tournament phase.
  const inTournamentPhase = eventPhase === "tournament";

  const handleStart = async () => {
    if (!window.confirm("WARNING: Are you sure you want to reset the entire tournament back to the Ready Room? This will clear all tournament progress and matches.")) {
      return;
    }
    setAdvancing(true);
    try {
      await adminApi("/api/admin/tournament/start", { method: "POST", body: {} });
      await loadData();
      notify("Tournament reset to Ready Room!", "success");
    } catch (err) {
      notify(err.message, "bad");
    } finally {
      setAdvancing(false);
    }
  };

  const handleSeed = async (count) => {
    setSeeding(true);
    try {
      await adminApi("/api/admin/tournament/seed", { body: { count } });
      await loadData();
      notify(`Successfully generated and registered ${count} mock bots!`, "success");
    } catch (err) {
      notify(err.message, "bad");
    } finally {
      setSeeding(false);
    }
  };

  const handleClearMock = async () => {
    if (!window.confirm("Are you sure you want to remove all generated mock bots and reset tournament data?")) return;
    setSeeding(true);
    try {
      await adminApi("/api/admin/tournament/clear-mock", { method: "POST", body: {} });
      await loadData();
      notify("Cleared all mock bots and reset tournament state.", "info");
    } catch (err) {
      notify(err.message, "bad");
    } finally {
      setSeeding(false);
    }
  };

  const handleAdvance = async () => {
    setAdvancing(true);
    try {
      await adminApi("/api/admin/tournament/advance", { body: {} });
      await loadData();
      notify("Advanced tournament to next stage!", "success");
    } catch (err) {
      notify(err.message, "bad");
    } finally {
      setAdvancing(false);
    }
  };

  const handleUndo = async () => {
    if (!window.confirm(`Undo ${stage.toUpperCase()}? Its results are discarded and the previous stage is shown again. Advancing afterwards re-runs it.`)) {
      return;
    }
    setAdvancing(true);
    try {
      const res = await adminApi("/api/admin/tournament/undo", { body: {} });
      await loadData();
      notify(`Undone. Back to ${res?.status?.stage?.toUpperCase() || "the previous stage"}.`, "info");
    } catch (err) {
      notify(err.message, "bad");
    } finally {
      setAdvancing(false);
    }
  };

  const handleTogglePause = async () => {
    setPausing(true);
    try {
      await adminApi("/api/admin/tournament/pause", { body: { paused: !paused } });
      await loadData();
      notify(paused ? "Tournament playback resumed" : "Tournament playback PAUSED", "info");
    } catch (err) {
      notify(err.message, "bad");
    } finally {
      setPausing(false);
    }
  };

  const handleStep = async (step) => {
    setStepping(true);
    try {
      await adminApi("/api/admin/tournament/step", { body: { step } });
      await loadData();
    } catch (err) {
      notify(err.message, "bad");
    } finally {
      setStepping(false);
    }
  };

  const getNextActionLabel = () => {
    const totalSwiss = status?.swiss_rounds || 8;
    if (stage === "ready_room") return "Launch Swiss Round 1 (Parallel 1v1)";
    if (stage.startsWith("swiss_")) {
      const rnd = parseInt(stage.replace("swiss_", ""), 10);
      if (rnd < totalSwiss) return `Launch Swiss Round ${rnd + 1} (Parallel 1v1)`;
      return "Conclude Swiss Stage → Trigger Top 32 Cut";
    }
    if (stage === "cut_ceremony") return "Launch Elimination: Round of 32 (1v1)";
    if (stage === "ro32") return "Launch Elimination: Round of 16 (1v1)";
    if (stage === "ro16") return "Launch Quarter-Finals (Match 1 of 4 - 1v1)";
    if (stage === "ro8_m1") return "Launch Quarter-Finals (Match 2 of 4 - 1v1)";
    if (stage === "ro8_m2") return "Launch Quarter-Finals (Match 3 of 4 - 1v1)";
    if (stage === "ro8_m3") return "Launch Quarter-Finals (Match 4 of 4 - 1v1)";
    if (stage === "ro8_m4") return "Launch Semi-Finals (Match 1 of 2 - 7 HP 1v1)";
    if (stage === "ro4_m1") return "Launch Semi-Finals (Match 2 of 2 - 7 HP 1v1)";
    if (stage === "ro4_m2") return "Launch Grand Finale (8 HP 1v1 Boss Fight)";
    if (stage === "finals") return "Conclude Tournament & Crown Champion";
    if (stage === "champion") return "Tournament Complete";
    return "Advance Stage";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Top Action Ribbon */}
      <div className="admin-box" style={{ background: "rgba(201, 169, 97, 0.06)", borderColor: "var(--t-gold-border, rgba(201, 169, 97, 0.3))" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <span style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--gold)" }}>
              Active Tournament Stage
            </span>
            <h2 style={{ margin: "4px 0", fontSize: "20px", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: paused ? "var(--red)" : "var(--green)", display: "inline-block" }} />
              {stage.toUpperCase()}
              {paused && <span style={{ fontSize: "12px", color: "var(--red)", fontWeight: 700 }}>(PAUSED)</span>}
            </h2>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              className="btn btn-sm btn-gold"
              onClick={() => window.open("/screen", "_blank")}
              title="Open full Big Screen view in new window"
            >
              Open Big Screen Projector ↗
            </button>

            <button
              className={`btn btn-sm ${paused ? "btn-gold" : "btn-quiet"}`}
              style={{ borderColor: paused ? undefined : "var(--red)", color: paused ? undefined : "var(--red)" }}
              onClick={handleTogglePause}
              disabled={pausing}
            >
              {pausing ? <span className="spinner" /> : null}
              {paused ? "▶ Resume Playback" : "⏸ Emergency Global Pause"}
            </button>
          </div>
        </div>
      </div>

      {/* Test Simulator & Mock Bot Generator */}
      <div className="admin-box" style={{ background: "rgba(255, 255, 255, 0.02)", borderStyle: "dashed" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <span className="admin-box-title">Tournament Simulator & Mock Bots</span>
          <span className="admin-badge badge-ok">
            {data?.total_participants || 0} Registered Entries
          </span>
        </div>
        <p className="faint" style={{ margin: "0 0 12px", fontSize: "12.5px" }}>
          Instantly populate the tournament with diverse 007 bot archetypes (Snipers, Counter-punchers, Smart predictors, Turtles) to test Swiss rounds, 3-tier movements, and single elimination brackets.
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="faint" style={{ fontSize: "12px", marginRight: 4 }}>Generate:</span>
          {[32, 64, 128, 256, 400].map((n) => (
            <button
              key={n}
              className="btn btn-xs btn-gold"
              onClick={() => handleSeed(n)}
              disabled={seeding || advancing}
            >
              +{n} Bots
            </button>
          ))}
          <button
            className="btn btn-xs btn-quiet"
            style={{ color: "var(--red)", marginLeft: "auto" }}
            onClick={handleClearMock}
            disabled={seeding || advancing || (data?.total_participants || 0) === 0}
          >
            Clear Mock Bots
          </button>
        </div>
      </div>

      {/* Main Advance Controller */}
      <div className="admin-box">
        <span className="admin-box-title">Tournament Progress Advancer</span>
        <p className="faint" style={{ margin: "4px 0 16px", fontSize: "13px" }}>
          Trigger stage transitions, compute parallel matches across worker threads, and push updates to all student screens.
        </p>

        {!inTournamentPhase && (
          <div className="note note-bad" style={{ marginBottom: 12 }}>
            The event is in the {String(eventPhase || "").toUpperCase()} phase. Switch it to Tournament in Phase
            Management (top of this page) before launching rounds.
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {stage === "ready_room" ? (
            <button
              className="btn btn-gold"
              onClick={handleAdvance}
              disabled={advancing || !inTournamentPhase}
            >
              {advancing ? <span className="spinner" /> : <IconPlay size={16} />}
              Launch Swiss Round 1 (Parallel 1v1)
            </button>
          ) : (
            <button
              className="btn btn-gold"
              onClick={handleAdvance}
              disabled={advancing || stage === "champion" || !inTournamentPhase}
            >
              {advancing ? <span className="spinner" /> : <IconPlay size={16} />}
              {getNextActionLabel()}
            </button>
          )}

          <button
            className="btn btn-quiet"
            onClick={handleUndo}
            disabled={advancing || stage === "ready_room"}
            title="Discard the current stage's results and go back one stage"
          >
            ↶ Undo Last Stage
          </button>

          <button className="btn btn-quiet" onClick={handleStart} title="Reset tournament to initial Ready Room state">
            Reset to Ready Room
          </button>
        </div>
      </div>

      {/* Grand Finale Step-by-Step Controller (Active in Finals) */}
      {(stage === "finals" || stage.startsWith("ro4_") || stage.startsWith("ro8_")) && (
        <div className="admin-box" style={{ background: "rgba(255, 255, 255, 0.02)" }}>
          <span className="admin-box-title">Grand Finale / Sequential Match Scrubber</span>
          <p className="faint" style={{ margin: "4px 0 12px", fontSize: "13px" }}>
            Control turn pacing for maximum stadium suspense during marquee clashes.
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              className={`btn btn-sm ${turnStep === -1 ? "btn-gold" : "btn-quiet"}`}
              onClick={() => handleStep(-1)}
              disabled={stepping}
            >
              Auto-Play Mode
            </button>
            <button
              className="btn btn-sm btn-quiet"
              onClick={() => handleStep(0)}
              disabled={stepping}
            >
              Reset to Turn 1
            </button>
            <button
              className="btn btn-sm btn-quiet"
              onClick={() => handleStep(turnStep >= 0 ? Math.max(0, turnStep - 1) : 0)}
              disabled={stepping}
            >
              ‹ Previous Turn
            </button>
            <button
              className="btn btn-sm btn-gold"
              onClick={() => handleStep(turnStep >= 0 ? turnStep + 1 : 0)}
              disabled={stepping}
            >
              Next Turn ›
            </button>
            <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--gold)" }}>
              {turnStep >= 0 ? `Manual Step: Turn ${turnStep + 1}` : "Mode: Automatic Playback"}
            </span>
          </div>
        </div>
      )}

      {/* Highlight Match Preview */}
      {data?.highlight && (
        <div className="admin-box">
          <span className="admin-box-title">Center Stage Highlight Match Preview</span>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
            <div>
              <span style={{ fontWeight: 700, fontSize: "16px", color: "var(--gold)" }}>
                {data.highlight.p1_name}{data.highlight.p1_real_name ? ` (${data.highlight.p1_real_name})` : ""}
              </span>
              <span style={{ margin: "0 10px", color: "var(--muted)" }}>VS</span>
              <span style={{ fontWeight: 700, fontSize: "16px", color: "var(--cyan, #00e5ff)" }}>
                {data.highlight.p2_name}{data.highlight.p2_real_name ? ` (${data.highlight.p2_real_name})` : ""}
              </span>
            </div>
            <span className="admin-badge badge-ok">
              Series: {data.highlight.p1_score} - {data.highlight.p2_score}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
