import React, { useEffect, useRef, useState } from "react";
import { api, storage } from "../../api";
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
        <div className="bs-hold">
          <span className="bs-eyebrow">Transmission</span>
          <div className="bs-hold-title">Stand by</div>
        </div>
      );
    }
    return this.props.children;
  }
}

const POLL_MS = 1500;
const BRACKET_KEY = "mcw.screen.bracketCollapsed";
const CONTROLS_IDLE_MS = 2500;

/** Eyebrow + title for the top bar, and where the stage sits on the progress rail. */
function stageInfo(stage, totalSwiss) {
  const n = (prefix) => stage.slice(prefix.length);
  if (stage.startsWith("swiss_")) return { eyebrow: "Swiss stage", title: `Round ${n("swiss_")} of ${totalSwiss}` };
  if (stage.startsWith("intermission_")) return { eyebrow: "Swiss stage", title: `Round ${n("intermission_")} complete` };
  if (stage === "cut_ceremony") return { eyebrow: "Swiss stage complete", title: "The Top 32" };
  if (stage === "ro32") return { eyebrow: "Knockout", title: "Round of 32" };
  if (stage === "ro16") return { eyebrow: "Knockout", title: "Round of 16" };
  if (stage.startsWith("ro8_")) return { eyebrow: "Quarter-finals", title: `Match ${n("ro8_m")} of 4` };
  if (stage.startsWith("ro4_")) return { eyebrow: "Semi-finals", title: `Match ${n("ro4_m")} of 2` };
  if (stage === "finals") return { eyebrow: "Grand final", title: "For the championship" };
  if (stage === "champion") return { eyebrow: "Tournament complete", title: "Champion crowned" };
  return { eyebrow: "007 Quickdraw", title: "Agents assembling" };
}

const KNOCKOUT_STEPS = [
  { label: "Cut", match: (s) => s === "cut_ceremony" },
  { label: "R32", match: (s) => s === "ro32" },
  { label: "R16", match: (s) => s === "ro16" },
  { label: "QF", match: (s) => s.startsWith("ro8_") },
  { label: "SF", match: (s) => s.startsWith("ro4_") },
  { label: "Final", match: (s) => s === "finals" },
];

/** The whole show at a glance: Swiss rounds as dots, then the knockout steps. */
function StageRail({ stage, totalSwiss }) {
  const swissRound = stage.startsWith("swiss_") || stage.startsWith("intermission_")
    ? Number(stage.replace(/^\D+/, "")) || 0
    : 0;
  const koIdx = KNOCKOUT_STEPS.findIndex((k) => k.match(stage));
  const swissDone = stage !== "ready_room" && swissRound === 0;
  const allDone = stage === "champion";
  const state = (i) => (allDone || (koIdx >= 0 && i < koIdx) ? "done" : i === koIdx ? "now" : "");

  return (
    <div className="bs-rail" aria-label="Tournament progress">
      <div className="bs-rail-group">
        <span className={`bs-rail-label ${swissRound ? "now" : swissDone ? "done" : ""}`}>Swiss</span>
        <div className="bs-rail-dots">
          {Array.from({ length: totalSwiss }).map((_, i) => (
            <i
              key={i}
              className={swissDone || i + 1 < swissRound ? "done" : i + 1 === swissRound ? "now" : ""}
            />
          ))}
        </div>
      </div>
      {KNOCKOUT_STEPS.map((k, i) => (
        <React.Fragment key={k.label}>
          <span className={`bs-rail-sep ${state(i)}`} />
          <span className={`bs-rail-label ${state(i)}`}>{k.label}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

function ChampionView({ match }) {
  if (!match) return <div className="bs-hold"><div className="bs-hold-title">Champion crowned</div></div>;
  const side = match.winner_id === match.p2_id ? "p2" : "p1";
  const other = side === "p1" ? "p2" : "p1";
  const bot = match[`${side}_name`];
  const real = match[`${side}_real_name`];
  const runnerUp = match[`${other}_real_name`] || match[`${other}_name`];

  return (
    <div className="bs-champion">
      <div className="bs-champion-rings" aria-hidden="true" />
      <span className="bs-eyebrow">007 Quickdraw · Champion</span>
      <div className="bs-champion-name">{real || bot}</div>
      {real && <div className="bs-champion-bot">{bot}</div>}
      <div className="bs-champion-rule" />
      {runnerUp && match[`${other}_name`] !== "BYE" && (
        <p className="bs-champion-note">Defeated {runnerUp} in the grand final</p>
      )}
    </div>
  );
}

export default function BigScreen({ onExit }) {
  const [data, setData] = useState(null);
  const [version, setVersion] = useState(0);
  const [offline, setOffline] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsShown, setControlsShown] = useState(true);
  const [bracketCollapsed, setBracketCollapsed] = useState(() => storage.get(BRACKET_KEY) === "1");
  const idleTimer = useRef(null);

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

  // The buttons (and cursor) stay out of the projected picture unless the mouse moves.
  useEffect(() => {
    const wake = () => {
      setControlsShown(true);
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setControlsShown(false), CONTROLS_IDLE_MS);
    };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
      clearTimeout(idleTimer.current);
    };
  }, []);

  const toggleBracket = () => setBracketCollapsed((c) => !c);
  useEffect(() => storage.set(BRACKET_KEY, bracketCollapsed ? "1" : "0"), [bracketCollapsed]);

  // B folds the knockout bracket away (or back) without reaching for the mouse.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === "b" || e.key === "B") && !e.ctrlKey && !e.metaKey && !e.altKey) toggleBracket();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
  const totalSwiss = status.swiss_rounds || 8;
  // Host turn-stepping pauses the clock too, but that's showmanship, not an announcement.
  const paused = Boolean(status.paused) && (status.turn_step ?? -1) < 0;
  const isSwiss = stage.startsWith("swiss_") || stage.startsWith("intermission_");
  const isCut = stage === "cut_ceremony";
  const isElimination = stage === "ro32" || stage === "ro16";
  const isSequentialFinals = stage.startsWith("ro8_") || stage.startsWith("ro4_") || stage === "finals";
  const isChampion = stage === "champion";
  const { eyebrow, title } = stageInfo(stage, totalSwiss);

  const layout = isSwiss
    ? "layout-swiss"
    : isElimination || isSequentialFinals
      ? `layout-bracket ${bracketCollapsed ? "is-collapsed" : ""}`
      : "layout-full";

  return (
    <div className={`tournament-screen big-screen ${controlsShown ? "" : "is-idle"}`}>
      <div className="screen-rings" aria-hidden="true" />

      <header className="bs-topbar">
        <div className="bs-brand">
          <img src="/logo.png" alt="WnCC" className="bs-brand-logo" />
          <span className="bs-brand-sep" />
          <span className="bs-brand-007">007</span>
          <span className="bs-brand-label">Quickdraw</span>
        </div>

        <div className="bs-stage" key={stage}>
          <span className="bs-eyebrow">
            <span className={`bs-live-dot ${paused ? "is-paused" : ""}`} />
            {eyebrow}
          </span>
          <span className="bs-stage-title">{title}</span>
        </div>

        <div className="bs-topbar-right">
          <StageRail stage={stage} totalSwiss={totalSwiss} />
        </div>
      </header>

      {/* Outside the header: its backdrop-filter would trap position: fixed */}
      <div className="bs-controls">
        {offline && <span className="bs-offline"><span className="spinner" /> Reconnecting</span>}
        <button className="bs-btn" onClick={toggleFullscreen} title="Fullscreen (F11)">
          {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
        {onExit && (
          <button className="bs-btn" onClick={onExit} title="Return to workspace">
            Exit
          </button>
        )}
      </div>

      <main className={`bs-content ${layout}`}>
        <ScreenErrorBoundary version={version}>
          {stage === "ready_room" && (
            <ReadyRoom totalParticipants={data?.total_participants || 0} swissRounds={totalSwiss} />
          )}

          {/* Swiss: live tier board beside the marquee duel. Bot names only. */}
          {isSwiss && (
            <>
              <TierBoard
                tiers={data?.tiers}
                baseStandings={data?.base_standings}
                roundMatches={data?.round_matches}
                status={status}
                totalParticipants={data?.total_participants || 0}
              />
              <BattleArena match={data?.highlight} status={status} sound revealNames={false} />
            </>
          )}

          {isCut && <CutCeremony tiers={data?.tiers} swissRounds={totalSwiss} />}

          {/* Knockout: the bracket beside the duel. Real names from the quarter-finals on. */}
          {(isElimination || isSequentialFinals) && (
            <>
              <TournamentBracket
                bracket={data?.bracket}
                activeStage={stage}
                revealNames={isSequentialFinals}
                status={status}
                collapsed={bracketCollapsed}
                onToggle={toggleBracket}
              />
              <BattleArena match={data?.highlight} status={status} sound revealNames={isSequentialFinals} />
            </>
          )}

          {isChampion && <ChampionView match={data?.highlight} />}
        </ScreenErrorBoundary>

        {paused && (
          <div className="bs-pause" role="status">
            <div className="bs-pause-card">
              <span className="bs-eyebrow">Playback paused</span>
              <div className="bs-pause-title">Stand by</div>
              <p>An announcement from the organisers. The duels resume exactly where they stopped.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
