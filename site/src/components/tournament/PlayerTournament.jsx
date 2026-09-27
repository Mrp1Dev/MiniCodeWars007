import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import BattleArena from "./BattleArena";
import ReadyRoom from "./ReadyRoom";
import CutCeremony from "./CutCeremony";
import TournamentBracket from "./TournamentBracket";
import "./tournament.css";

export default function PlayerTournament({ me, eventStatus, onSignOut }) {
  const [status, setStatus] = useState(null);
  const [data, setData] = useState(null);
  const [offline, setOffline] = useState(false);
  const [bracketOpen, setBracketOpen] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);

  const prevStageRef = useRef(null);
  const prevStartedAtRef = useRef(null);

  // 1. Jittered low-frequency status polling (2.5s - 3.5s) to avoid 400-client synchronization
  const fetchStatus = useCallback(async () => {
    try {
      const s = await api("/api/tournament/status");
      setStatus(s);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    let stop = false;
    let timer = null;

    const schedulePoll = () => {
      // 2600ms + random jitter up to 900ms
      const jitterMs = 2600 + Math.random() * 900;
      timer = setTimeout(async () => {
        if (stop) return;
        await fetchStatus();
        if (!stop) schedulePoll();
      }, jitterMs);
    };

    fetchStatus();
    schedulePoll();

    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchStatus]);

  // 2. Single-shot replay and participant data fetching when round or stage advances
  const fetchMyMatch = useCallback(async () => {
    try {
      const res = await api("/api/tournament/my-match", { token: me?.roll });
      setData(res);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [me?.roll]);

  useEffect(() => {
    if (!status) return;

    const stageChanged = status.stage !== prevStageRef.current;
    const roundRestarted = status.started_at !== prevStartedAtRef.current;

    if (stageChanged || roundRestarted || !data) {
      prevStageRef.current = status.stage;
      prevStartedAtRef.current = status.started_at;

      // Stagger replay request with 0 - 800ms random delay so 400 clients don't hit the server at once
      const staggerDelay = Math.floor(Math.random() * 800);
      const timer = setTimeout(fetchMyMatch, staggerDelay);
      return () => clearTimeout(timer);
    }
  }, [status, data, fetchMyMatch]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        setBracketOpen(false);
        setCodeOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeStage = status?.stage || "ready_room";
  const paused = status?.paused || false;
  const role = data?.role || "ready";
  const myStanding = data?.my_standing || null;

  const isReady = activeStage === "ready_room";
  const isCut = activeStage === "cut_ceremony";
  const isChampion = activeStage === "champion";
  const isSequentialFinals =
    activeStage.startsWith("ro8_") ||
    activeStage.startsWith("ro4_") ||
    activeStage === "finals";

  const getStageTitle = () => {
    if (activeStage === "ready_room") return "STAGE 0: READY ROOM";
    if (activeStage.startsWith("swiss_")) {
      const rnd = activeStage.replace("swiss_", "");
      const totalSwiss = status?.swiss_rounds || 8;
      return `SWISS STAGE · ROUND ${rnd} OF ${totalSwiss}`;
    }
    if (activeStage === "cut_ceremony") return "ACT 1 CONCLUDED · THE TOP 32 CUT";
    if (activeStage === "ro32") return "SINGLE ELIMINATION · ROUND OF 32 (1V1)";
    if (activeStage === "ro16") return "SINGLE ELIMINATION · ROUND OF 16 (1V1)";
    if (activeStage.startsWith("ro8_")) {
      const m = activeStage.replace("ro8_m", "");
      return `QUARTER-FINALS · MATCH ${m} OF 4 (1V1)`;
    }
    if (activeStage.startsWith("ro4_")) {
      const m = activeStage.replace("ro4_m", "");
      return `SEMI-FINALS · MATCH ${m} OF 2 (7 HP 1V1)`;
    }
    if (activeStage === "finals") return "GRAND FINALE · WORLD CHAMPIONSHIP (8 HP 1V1)";
    if (activeStage === "champion") return "TOURNAMENT CHAMPION CROWNED";
    return activeStage.toUpperCase();
  };

  const getMirrorTag = () => {
    if (role === "bye") {
      return "★ AUTOMATIC ADVANCE (BYE) · BIG SCREEN MIRROR";
    }
    if (role === "eliminated") {
      return "★ SPECTATOR ARENA (BIG SCREEN MIRROR)";
    }
    if (isSequentialFinals) {
      return "★ FINALS CENTER STAGE · LIVE BROADCAST";
    }
    return "★ BIG SCREEN MIRROR";
  };

  return (
    <div className="tournament-screen player-arena-screen">
      <div className="screen-rings" aria-hidden="true" />

      {/* Top Player HUD Bar */}
      <header className="screen-topbar player-topbar">
        <div className="screen-brand">
          <img src="/logo.png" alt="WnCC" className="screen-brand-logo" />
          <span className="screen-brand-sep" />
          <span className="screen-brand-007">007</span>
          <span className="screen-brand-label">ARENA</span>
        </div>

        <div className="screen-center-stage">
          <div className="stage-badge">
            <span className="stage-badge-dot" />
            <span>{getStageTitle()}</span>
          </div>

          {/* Personal Record & Standing Chip */}
          {myStanding && (
            <div className="player-stat-chip" title="Your tournament record so far">
              <span className="player-stat-chip-label">RECORD:</span>
              <strong className="player-stat-chip-val">
                {myStanding.match_wins}W - {myStanding.match_losses}L
              </strong>
              <span className="player-stat-chip-sep" />
              <span className="player-stat-chip-tier">
                TIER {myStanding.tier}
              </span>
              <span className="player-stat-chip-sep" />
              <span className="player-stat-chip-rank">
                RANK #{myStanding.rank}
              </span>
            </div>
          )}
        </div>

        <div className="screen-controls player-controls">
          {/* Persistent Drawers: Bracket & My Code */}
          <button
            className={`screen-btn ${bracketOpen ? "active" : ""}`}
            onClick={() => setBracketOpen((o) => !o)}
            title="View elimination bracket"
          >
            🏆 Bracket
          </button>
          <button
            className={`screen-btn ${codeOpen ? "active" : ""}`}
            onClick={() => setCodeOpen((o) => !o)}
            title="Inspect your submitted bot code"
          >
            💻 My Code
          </button>
          {onSignOut && (
            <button className="screen-btn-subtle" onClick={onSignOut} title="Sign out">
              Sign out
            </button>
          )}
        </div>
      </header>

      {/* Disconnection Warning (Non-intrusive) */}
      {offline && (
        <div className="player-offline-pill">
          <span>⚠️ Reconnecting to server... (Match playback running locally)</span>
        </div>
      )}

      {/* Emergency Pause Overlay Banner */}
      {paused && (
        <div className="screen-pause-banner">
          <span>⚠️ TOURNAMENT PLAYBACK PAUSED FOR ORGANIZER ANNOUNCEMENT</span>
        </div>
      )}

      {/* Main Content Area */}
      <main className="screen-content full-width player-screen-content">
        {/* Stage 0: Ready Room */}
        {isReady && (
          <div className="player-ready-wrapper">
            <ReadyRoom totalParticipants={data?.total_participants || 0} />
            <div className="player-primed-card">
              <div className="player-primed-dot" />
              <div>
                <div style={{ fontSize: "12px", color: "var(--t-muted)", letterSpacing: "0.1em" }}>
                  REGISTERED CONTENDER
                </div>
                <div style={{ fontSize: "18px", fontWeight: 700, color: "var(--t-gold)" }}>
                  {me?.bot_name || me?.name}
                  <span style={{ fontSize: "14px", color: "#fff", fontWeight: 400, marginLeft: 8 }}>
                    ({me?.roll})
                  </span>
                </div>
              </div>
              <div className="player-primed-tag">PRIMED & READY</div>
            </div>
          </div>
        )}

        {/* Swiss & Elimination Matches */}
        {!isReady && !isCut && !isChampion && (
          <div className="player-arena-container">
            {/* Bye round celebration notice */}
            {role === "bye" && (
              <div className="player-bye-banner">
                <span className="player-bye-icon">⭐</span>
                <div>
                  <strong>AUTOMATIC ADVANCE (BYE ROUND):</strong> You were awarded an automatic 1-0 victory (+1 Match Win) for this round. Mirroring the Big Screen marquee duel below!
                </div>
              </div>
            )}

            {/* Eliminated participant spectator notification */}
            {role === "eliminated" && (
              <div className="player-spectator-banner">
                <span>👁️ <strong>SPECTATOR MODE:</strong> Your bot has completed its tournament run. Mirroring live arena duels from the Big Screen!</span>
              </div>
            )}

            {/* Battle Arena View (Reused 100%) */}
            {!data ? (
              <div
                className="arena-card center muted"
                style={{
                  padding: "60px 20px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                }}
              >
                <span className="spinner" /> Synchronizing arena duel...
              </div>
            ) : (
              <BattleArena
                match={data?.match}
                status={status}
                revealNames={Boolean(status?.reveal_names)}
                isSequential={Boolean(status?.is_sequential)}
                myParticipantId={me?.id}
                isMirroring={Boolean(data?.is_mirroring)}
                mirrorTag={getMirrorTag()}
              />
            )}
          </div>
        )}

        {/* Act 1 Concluded: Top 32 Cut Ceremony */}
        {isCut && (
          <div className="player-cut-wrapper">
            {myStanding?.qualified_top32 ? (
              <div className="player-cut-status qualified">
                <span className="cut-status-icon">🏆</span>
                <div>
                  <h2 style={{ margin: 0, fontSize: "22px", color: "var(--t-gold)" }}>
                    CONGRATULATIONS! YOU MADE THE TOP 32!
                  </h2>
                  <p style={{ margin: "4px 0 0", color: "#f0f6fc", fontSize: "14px" }}>
                    Your bot qualified with seed <strong>#{myStanding.rank}</strong> ({myStanding.match_wins}W - {myStanding.match_losses}L). Advancing to the Single Elimination Championship Bracket!
                  </p>
                </div>
              </div>
            ) : (
              <div className="player-cut-status non-qualified">
                <span className="cut-status-icon">🎯</span>
                <div>
                  <h2 style={{ margin: 0, fontSize: "20px", color: "#fff" }}>
                    SWISS STAGE COMPLETE · HONORABLE CONTENDER
                  </h2>
                  <p style={{ margin: "4px 0 0", color: "var(--t-muted)", fontSize: "14px" }}>
                    Final Swiss Standing: <strong>#{myStanding?.rank || "-"}</strong> ({myStanding?.match_wins || 0}W - {myStanding?.match_losses || 0}L). You are now an official spectator for the Top 32 Elimination Championship!
                  </p>
                </div>
              </div>
            )}

            {/* Reused Cut Ceremony Grid */}
            <CutCeremony tiers={data?.tiers} />
          </div>
        )}

        {/* Champion Crowning */}
        {isChampion && (
          <div className="cut-ceremony-container" style={{ textAlign: "center", gap: 24 }}>
            <div className="cut-banner" style={{ fontSize: "44px" }}>
              🏆 TOURNAMENT CHAMPION CROWNED 🏆
            </div>
            <div className="ready-counter" style={{ fontSize: "26px", padding: "12px 36px" }}>
              {data?.match?.winner_id === data?.match?.p1_id
                ? `${data?.match?.p1_real_name} (${data?.match?.p1_name})`
                : `${data?.match?.p2_real_name} (${data?.match?.p2_name})`}
            </div>
            {myStanding && (
              <div className="player-champion-recap">
                <div style={{ color: "var(--t-gold)", fontWeight: 700, fontSize: "16px", marginBottom: 8 }}>
                  YOUR TOURNAMENT SUMMARY
                </div>
                <div style={{ display: "flex", justifyContent: "center", gap: 24, fontSize: "15px" }}>
                  <div>Final Rank: <strong>#{myStanding.rank}</strong></div>
                  <div>Record: <strong>{myStanding.match_wins}W - {myStanding.match_losses}L</strong></div>
                  <div>Damage Dealt: <strong>{myStanding.damage_dealt || 0} DMG</strong></div>
                  <div>Fumbles: <strong>{myStanding.fumbles || 0}</strong></div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Persistent Drawer: Tournament Bracket */}
      {bracketOpen && (
        <div className="player-drawer-backdrop" onClick={() => setBracketOpen(false)}>
          <div className="player-drawer-content bracket-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="player-drawer-header">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: "20px" }}>🏆</span>
                <span style={{ fontWeight: 700, fontSize: "16px", color: "var(--t-gold)" }}>
                  TOP 32 ELIMINATION BRACKET
                </span>
              </div>
              <button className="screen-btn-close" onClick={() => setBracketOpen(false)}>
                ✕ Close
              </button>
            </div>
            <div className="player-drawer-body">
              <TournamentBracket
                bracket={data?.bracket || []}
                activeStage={activeStage}
                revealNames={Boolean(status?.reveal_names)}
                status={status || {}}
              />
            </div>
          </div>
        </div>
      )}

      {/* Persistent Drawer: My Code */}
      {codeOpen && (
        <div className="player-drawer-backdrop" onClick={() => setCodeOpen(false)}>
          <div className="player-drawer-content code-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="player-drawer-header">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: "20px" }}>💻</span>
                <span style={{ fontWeight: 700, fontSize: "16px", color: "var(--t-gold)" }}>
                  SUBMITTED BOT: {me?.bot_name || me?.name}.py
                </span>
              </div>
              <button className="screen-btn-close" onClick={() => setCodeOpen(false)}>
                ✕ Close
              </button>
            </div>
            <div className="player-drawer-body">
              <pre className="player-code-pre">
                {me?.entry?.code || "# No submitted code found for this entry."}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
