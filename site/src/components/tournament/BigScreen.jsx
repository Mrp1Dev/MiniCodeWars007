import React, { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import BattleArena from "./BattleArena";
import TierBoard from "./TierBoard";
import ReadyRoom from "./ReadyRoom";
import CutCeremony from "./CutCeremony";
import TournamentBracket from "./TournamentBracket";
import "./tournament.css";

export default function BigScreen({ onExit }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Poll Big Screen endpoint every 1.5s
  const fetchScreenData = useCallback(async () => {
    try {
      const res = await api("/api/tournament/screen");
      setData(res);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    fetchScreenData();
    const interval = setInterval(fetchScreenData, 1500);
    return () => clearInterval(interval);
  }, [fetchScreenData]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  const status = data?.status || {};
  const stage = status.stage || "ready_room";
  const paused = status.paused || false;
  const isSwiss = stage.startsWith("swiss_") || stage.startsWith("intermission_");
  const isCut = stage === "cut_ceremony";
  const isElimination = stage === "ro32" || stage === "ro16";
  const isSequentialFinals = stage.startsWith("ro8_") || stage.startsWith("ro4_") || stage === "finals";
  const isChampion = stage === "champion";

  const getStageTitle = () => {
    if (stage === "ready_room") return "STAGE 0: READY ROOM";
    if (stage.startsWith("swiss_")) {
      const rnd = stage.replace("swiss_", "");
      return `SWISS STAGE · ROUND ${rnd} OF 6`;
    }
    if (stage.startsWith("intermission_")) {
      const rnd = stage.replace("intermission_", "");
      return `SWISS ROUND ${rnd} COMPLETE · TIERS UPDATED`;
    }
    if (stage === "cut_ceremony") return "ACT 1 CONCLUDED · THE TOP 32 CUT";
    if (stage === "ro32") return "SINGLE ELIMINATION · ROUND OF 32";
    if (stage === "ro16") return "SINGLE ELIMINATION · ROUND OF 16";
    if (stage.startsWith("ro8_")) {
      const m = stage.replace("ro8_m", "");
      return `QUARTER-FINALS · MATCH ${m} OF 4`;
    }
    if (stage.startsWith("ro4_")) {
      const m = stage.replace("ro4_m", "");
      return `SEMI-FINALS · MATCH ${m} OF 2 (BEST OF 7)`;
    }
    if (stage === "finals") return "GRAND FINALE · WORLD CHAMPIONSHIP (BEST OF 7)";
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
              isSequential={false}
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
              isSequential={false}
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
              isSequential={true}
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
              {data?.highlight?.winner_id === data?.highlight?.p1_id
                ? `${data?.highlight?.p1_real_name} (${data?.highlight?.p1_name})`
                : `${data?.highlight?.p2_real_name} (${data?.highlight?.p2_name})`}
            </div>
            <p className="faint" style={{ fontSize: "16px", maxWidth: "600px" }}>
              Congratulations to the champion of MiniCodeWars 007! Winner of the grand prize and undisputed 007 agent.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
