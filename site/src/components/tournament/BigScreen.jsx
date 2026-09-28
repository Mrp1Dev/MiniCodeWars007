import React, { useEffect, useState } from "react";
import { api } from "../../api";
import BattleArena from "./BattleArena";
import TierBoard from "./TierBoard";
import ReadyRoom from "./ReadyRoom";
import CutCeremony from "./CutCeremony";
import TournamentBracket from "./TournamentBracket";
import "./tournament.css";

// A rendering bug must never leave the projector blank: show a holding card and retry on the next poll.
class ScreenErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failedAt: null };
  }

  static getDerivedStateFromError() {
    return { failedAt: Date.now() };
  }

  componentDidCatch(err) {
    console.error("Big Screen render error:", err);
  }

  componentDidUpdate(prevProps) {
    if (this.state.failedAt && prevProps.version !== this.props.version) {
      this.setState({ failedAt: null });
    }
  }

  render() {
    if (this.state.failedAt) {
      return (
        <div className="cut-ceremony-container" style={{ textAlign: "center" }}>
          <div className="cut-banner">STAND BY</div>
        </div>
      );
    }
    return this.props.children;
  }
}

const POLL_MS = 1500;

export default function BigScreen({ onExit }) {
  const [data, setData] = useState(null);
  const [version, setVersion] = useState(0);
  const [offline, setOffline] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Poll the Big Screen endpoint. One request at a time, so a slow response can never
  // land after a newer one and rewind the screen.
  useEffect(() => {
    let stopped = false;
    let timer = null;
    const poll = async () => {
      try {
        const res = await api("/api/tournament/screen");
        if (stopped) return;
        setData(res);
        setVersion((v) => v + 1);
        setOffline(false);
      } catch {
        if (!stopped) setOffline(true);
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  // Esc / F11 leave fullscreen without going through the button.
  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  const status = data?.status || {};
  const stage = status.stage || "ready_room";
  // Host turn-stepping pauses the clock too, but that's showmanship, not an announcement.
  const paused = Boolean(status.paused) && (status.turn_step ?? -1) < 0;
  const isSwiss = stage.startsWith("swiss_") || stage.startsWith("intermission_");
  const isCut = stage === "cut_ceremony";
  const isElimination = stage === "ro32" || stage === "ro16";
  const isSequentialFinals = stage.startsWith("ro8_") || stage.startsWith("ro4_") || stage === "finals";
  const isChampion = stage === "champion";

  const getStageTitle = () => {
    if (stage === "ready_room") return "STAGE 0: READY ROOM";
    if (stage.startsWith("swiss_")) {
      const rnd = stage.replace("swiss_", "");
      const totalSwiss = status?.swiss_rounds || 8;
      return `SWISS STAGE · ROUND ${rnd} OF ${totalSwiss}`;
    }
    if (stage.startsWith("intermission_")) {
      const rnd = stage.replace("intermission_", "");
      return `SWISS ROUND ${rnd} COMPLETE · TIERS UPDATED`;
    }
    if (stage === "cut_ceremony") return "ACT 1 CONCLUDED · THE TOP 32 CUT";
    if (stage === "ro32") return "SINGLE ELIMINATION · ROUND OF 32 (1V1)";
    if (stage === "ro16") return "SINGLE ELIMINATION · ROUND OF 16 (1V1)";
    if (stage.startsWith("ro8_")) {
      const m = stage.replace("ro8_m", "");
      return `QUARTER-FINALS · MATCH ${m} OF 4 (1V1)`;
    }
    if (stage.startsWith("ro4_")) {
      const m = stage.replace("ro4_m", "");
      return `SEMI-FINALS · MATCH ${m} OF 2 (7 HP 1V1)`;
    }
    if (stage === "finals") return "GRAND FINALE · WORLD CHAMPIONSHIP (8 HP 1V1)";
    if (stage === "champion") return "TOURNAMENT CHAMPION CROWNED";
    return stage.toUpperCase();
  };

  return (
    <div className="tournament-screen">
      <div className="screen-rings" aria-hidden="true" />

      {/* Top Navigation HUD */}
      <header className="screen-topbar">
        <div className="screen-brand">
          <img src="/logo.png" alt="WnCC" className="screen-brand-logo" />
          <span className="screen-brand-sep" />
          <span className="screen-brand-007">007</span>
          <span className="screen-brand-label">TOURNAMENT ARENA</span>
        </div>

        <div className="screen-center-stage">
          <div className="stage-badge">
            <span className="stage-badge-dot" />
            <span>{getStageTitle()}</span>
          </div>
        </div>

        <div className="screen-controls">
          <button className="screen-btn" onClick={toggleFullscreen} title="Fullscreen mode">
            {isFullscreen ? "Exit Fullscreen" : "Fullscreen (F11)"}
          </button>
          {offline && (
            <span className="screen-btn" title="Can't reach the server; retrying" style={{ color: "var(--t-muted)" }}>
              Reconnecting…
            </span>
          )}
          {onExit && (
            <button className="screen-btn" onClick={onExit} title="Return to workspace">
              Exit
            </button>
          )}
        </div>
      </header>

      {/* Emergency Pause Overlay Banner */}
      {paused && (
        <div className="screen-pause-banner">
          <span>⚠️ TOURNAMENT PLAYBACK PAUSED FOR ORGANIZER ANNOUNCEMENT</span>
        </div>
      )}

      {/* Main Content Router */}
      <main className={`screen-content ${stage === "ready_room" || isCut || isChampion ? "full-width" : ""}`}>
       <ScreenErrorBoundary version={version}>
        {/* Pre-tournament Ready Room */}
        {stage === "ready_room" && (
          <ReadyRoom totalParticipants={data?.total_participants || 0} />
        )}

        {/* Swiss Stage (Rounds 1-6 + Intermissions): 3-Tier Board on Left + Center Arena on Right */}
        {isSwiss && (
          <>
            <TierBoard
              tiers={data?.tiers}
              roundNumber={status.round_number}
              baseStandings={data?.base_standings}
              roundMatches={data?.round_matches}
              status={status}
            />
            <BattleArena
              match={data?.highlight}
              status={status}
              revealNames={false}
            />
          </>
        )}

        {/* Top 32 Cut Ceremony */}
        {isCut && (
          <CutCeremony tiers={data?.tiers} />
        )}

        {/* Elimination Ro32 & Ro16: Left Bracket + Center Highlight Duel */}
        {isElimination && (
          <>
            <TournamentBracket
              bracket={data?.bracket}
              activeStage={stage}
              revealNames={false}
              status={status}
            />
            <BattleArena
              match={data?.highlight}
              status={status}
              revealNames={false}
            />
          </>
        )}

        {/* Sequential Finals (Ro8, Ro4, Finals): Bracket Left + Full Arena with Real Names Revealed */}
        {isSequentialFinals && (
          <>
            <TournamentBracket
              bracket={data?.bracket}
              activeStage={stage}
              revealNames={true}
              status={status}
            />
            <BattleArena
              match={data?.highlight}
              status={status}
              revealNames={true}
            />
          </>
        )}

        {/* Champion Victory Screen */}
        {isChampion && (
          <div className="cut-ceremony-container" style={{ textAlign: "center", gap: 30 }}>
            <div className="cut-banner" style={{ fontSize: "52px" }}>
              🏆 TOURNAMENT CHAMPION 🏆
            </div>
            <div className="ready-counter" style={{ fontSize: "28px", padding: "12px 36px" }}>
              {(() => {
                const h = data?.highlight;
                if (!h) return "";
                const side = h.winner_id === h.p1_id ? "p1" : "p2";
                const real = h[`${side}_real_name`];
                return real ? `${real} (${h[`${side}_name`]})` : h[`${side}_name`];
              })()}
            </div>
            <p className="faint" style={{ fontSize: "16px", maxWidth: "600px" }}>
              Congratulations to the champion of 007 Quickdraw! Winner of the grand prize and undisputed 007 agent.
            </p>
          </div>
        )}
       </ScreenErrorBoundary>
      </main>
    </div>
  );
}
