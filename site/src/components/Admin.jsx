import { useCallback, useEffect, useMemo, useState } from "react";
import { adminApi, getAdminKey, setAdminKey } from "../api";
import { formatClock, useEventStatus, useSecondsLeft } from "../hooks";
import {
  Barrel,
  IconAlert,
  IconCheck,
  IconChevron,
  IconClock,
  IconClose,
  IconCode,
  IconCopy,
  IconDownload,
  IconKey,
  IconLock,
  IconMegaphone,
  IconPlay,
  IconRefresh,
  IconSearch,
  IconSpark,
  IconUser,
} from "./icons";
import "../admin.css";

const PRESET_MINUTES = [15, 20, 30, 45];
const EXTEND_MINUTES = [2, 5, 10, -5];

export default function Admin({ onExit }) {
  const [adminKey, setKey] = useState(getAdminKey());
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authChecking, setAuthChecking] = useState(false);

  // Status & live clock
  const { status, offline, refresh: refreshStatus } = useEventStatus();
  const secondsLeft = useSecondsLeft(status);

  // Active tab: "participants" | "entries" | "ai"
  const [tab, setTab] = useState("participants");

  // Tab data
  const [participants, setParticipants] = useState([]);
  const [entries, setEntries] = useState([]);
  const [aiUsage, setAiUsage] = useState(null);
  const [aiRequests, setAiRequests] = useState([]);

  // Loading & refresh states
  const [loadingData, setLoadingData] = useState(false);
  const [actionMsg, setActionMsg] = useState({ text: "", type: "info" });

  // Form controls
  const [codingMinutes, setCodingMinutes] = useState(30);
  const [customExtend, setCustomExtend] = useState("");
  const [announcementInput, setAnnouncementInput] = useState("");

  // Modals & Inspection
  const [inspectedEntry, setInspectedEntry] = useState(null); // entry object
  const [inspectedAi, setInspectedAi] = useState(null); // ai_request object
  const [copiedText, setCopiedText] = useState(false);

  // Filters & search
  const [participantSearch, setParticipantSearch] = useState("");
  const [participantFilter, setParticipantFilter] = useState("all");
  const [entriesSearch, setEntriesSearch] = useState("");
  const [aiFilter, setAiFilter] = useState("all");

  // Authenticate key with server
  const testAuth = useCallback(async (keyToTest) => {
    if (!keyToTest) return false;
    setAuthChecking(true);
    setAuthError("");
    try {
      await adminApi("/api/admin/participants", { key: keyToTest });
      setAdminKey(keyToTest);
      setKey(keyToTest);
      setIsAuthenticated(true);
      return true;
    } catch (err) {
      setIsAuthenticated(false);
      setAuthError(err.message || "Invalid admin key");
      return false;
    } finally {
      setAuthChecking(false);
    }
  }, []);

  // Check stored key on mount
  useEffect(() => {
    if (adminKey) {
      testAuth(adminKey);
    }
  }, [adminKey, testAuth]);

  // Load tab data
  const loadDashboardData = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoadingData(true);
    try {
      const [parts, ents, aiU, aiR] = await Promise.all([
        adminApi("/api/admin/participants"),
        adminApi("/api/admin/entries"),
        adminApi("/api/admin/ai-usage").catch(() => null),
        adminApi("/api/admin/ai-requests?limit=150").catch(() => []),
      ]);
      setParticipants(parts || []);
      setEntries(ents || []);
      setAiUsage(aiU);
      setAiRequests(aiR || []);
    } catch (e) {
      if (e.status === 401) {
        setIsAuthenticated(false);
        setAuthError("Session expired or admin key revoked.");
      }
    } finally {
      setLoadingData(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      loadDashboardData();
      const interval = setInterval(loadDashboardData, 12000);
      return () => clearInterval(interval);
    }
  }, [isAuthenticated, loadDashboardData]);

  // Helper for action alerts
  const notify = (text, type = "info") => {
    setActionMsg({ text, type });
    setTimeout(() => setActionMsg({ text: "", type: "info" }), 4500);
  };

  // Phase Actions
  async function handleSetPhase(phase, minutes = null) {
    try {
      const body = { phase };
      if (phase === "coding" && minutes) {
        body.minutes = Number(minutes);
      }
      await adminApi("/api/admin/phase", { body });
      refreshStatus();
      loadDashboardData();
      notify(`Phase changed to ${phase.toUpperCase()}${minutes ? ` (${minutes}m)` : ""}`, "success");
    } catch (err) {
      notify(err.message, "bad");
    }
  }

  async function handleExtend(minutes) {
    try {
      await adminApi("/api/admin/extend", { body: { minutes: Number(minutes) } });
      refreshStatus();
      notify(`Timer extended by ${minutes > 0 ? `+${minutes}` : minutes} min`, "success");
    } catch (err) {
      notify(err.message, "bad");
    }
  }

  async function handleAnnounce(e) {
    if (e) e.preventDefault();
    try {
      await adminApi("/api/admin/announce", { body: { message: announcementInput } });
      refreshStatus();
      notify(announcementInput ? "Announcement broadcasted" : "Announcement cleared", "success");
      setAnnouncementInput("");
    } catch (err) {
      notify(err.message, "bad");
    }
  }

  async function handleClearAnnounce() {
    try {
      await adminApi("/api/admin/announce", { body: { message: "" } });
      refreshStatus();
      notify("Announcement cleared", "success");
    } catch (err) {
      notify(err.message, "bad");
    }
  }

  function copyToClipboard(str) {
    navigator.clipboard.writeText(str).then(() => {
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 2000);
    });
  }

  function downloadEntriesJson() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(entries, null, 2));
    const a = document.createElement("a");
    a.setAttribute("href", dataStr);
    a.setAttribute("download", `minicodewars_entries_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function downloadSingleBot(roll, code) {
    const blob = new Blob([code], { type: "text/x-python" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${roll.toLowerCase()}_bot.py`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Filtered Participants
  const filteredParticipants = useMemo(() => {
    return participants.filter((p) => {
      const q = participantSearch.toLowerCase();
      const matchesSearch =
        !participantSearch ||
        p.roll.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        (p.bot_name && p.bot_name.toLowerCase().includes(q));
      if (!matchesSearch) return false;
      if (participantFilter === "has_entry") return p.entry_id != null;
      if (participantFilter === "no_entry") return p.entry_id == null;
      if (participantFilter === "warning") return p.last_status === "warning";
      if (participantFilter === "ok") return p.last_status === "ok";
      return true;
    });
  }, [participants, participantSearch, participantFilter]);

  // Filtered Entries
  const filteredEntries = useMemo(() => {
    return entries.filter((e) => {
      if (!entriesSearch) return true;
      const q = entriesSearch.toLowerCase();
      return (
        e.roll.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        (e.bot_name && e.bot_name.toLowerCase().includes(q))
      );
    });
  }, [entries, entriesSearch]);

  // Filtered AI Requests
  const filteredAi = useMemo(() => {
    return aiRequests.filter((r) => {
      if (aiFilter === "all") return true;
      return r.status === aiFilter;
    });
  }, [aiRequests, aiFilter]);

  // Unlock Screen if not authenticated
  if (!isAuthenticated) {
    return (
      <div className="admin-auth-screen">
        <div className="admin-auth-card">
          <div className="center">
            <Barrel size={36} />
            <h2 style={{ margin: "14px 0 4px", fontSize: "18px", letterSpacing: "0.05em" }}>Host Admin Access</h2>
            <p className="muted" style={{ margin: 0, fontSize: "13px" }}>
              Enter the admin key printed when starting the server or found in <code>data/admin_key.txt</code>.
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              testAuth(adminKey);
            }}
            style={{ display: "flex", flexDirection: "column", gap: "12px" }}
          >
            <label className="field">
              <span>Admin Key</span>
              <input
                autoFocus
                type="password"
                value={adminKey}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Enter secret admin key"
                spellCheck={false}
              />
            </label>

            {authError && <div className="note note-bad">{authError}</div>}

            <button type="submit" className="btn btn-gold btn-block" disabled={authChecking || !adminKey.trim()}>
              {authChecking ? <span className="spinner" /> : <IconKey />} Unlock Dashboard
            </button>
          </form>

          {onExit && (
            <button type="button" className="btn btn-quiet btn-sm center" onClick={onExit}>
              ← Return to Participant Site
            </button>
          )}
        </div>
      </div>
    );
  }

  const phase = status ? status.phase : "loading";

  return (
    <div className="admin-layout">
      {/* Top Header */}
      <header className="admin-header">
        <div className="admin-header-brand">
          <Barrel size={22} />
          <span className="admin-brand-title">
            MCW 007 <span className="faint">/</span> Host Admin
          </span>
          <span className={`admin-badge badge-${phase}`}>
            {phase === "coding" && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />}
            {phase}
          </span>
          {phase === "coding" && secondsLeft !== null && (
            <span className="admin-clock-pill">
              <IconClock size={14} />
              {secondsLeft > 0 ? formatClock(secondsLeft) : "TIME UP"}
            </span>
          )}
          {offline && <span className="admin-badge badge-error">Offline</span>}
        </div>

        <div className="admin-header-actions">
          {actionMsg.text && (
            <span style={{ fontSize: "12.5px", color: actionMsg.type === "bad" ? "var(--red)" : "var(--green)", fontWeight: 550 }}>
              {actionMsg.text}
            </span>
          )}
          <button
            className="btn btn-sm btn-quiet"
            title="Refresh All Data"
            onClick={() => {
              refreshStatus();
              loadDashboardData();
            }}
            disabled={loadingData}
          >
            <IconRefresh size={14} /> Refresh
          </button>
          <button
            className="btn btn-sm btn-quiet"
            onClick={() => {
              setAdminKey("");
              setKey("");
              setIsAuthenticated(false);
            }}
          >
            Sign out
          </button>
          {onExit && (
            <button className="btn btn-sm btn-gold" onClick={onExit}>
              ← Participant Site
            </button>
          )}
        </div>
      </header>

      <main className="admin-main">
        {/* Phase & Live Event Control Hub */}
        <section className="admin-card">
          <div className="admin-card-header">
            <span className="admin-card-title">
              <IconPlay size={15} /> Event Lifecycle & Controls
            </span>
            <span className="eyebrow">
              Server Time: {status ? new Date(status.server_time * 1000).toLocaleTimeString() : "--"}
            </span>
          </div>

          <div className="admin-controls-grid">
            {/* Box 1: Phase Control */}
            <div className="admin-box">
              <span className="admin-box-title">Phase Management</span>

              {phase === "registration" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <p className="muted" style={{ margin: 0, fontSize: "13px" }}>
                    Participants can currently sign in, write pseudocode and practice. Start the coding round when ready:
                  </p>
                  <div className="btn-group">
                    {PRESET_MINUTES.map((m) => (
                      <button
                        key={m}
                        className={`btn btn-xs ${codingMinutes === m ? "btn-gold" : ""}`}
                        onClick={() => setCodingMinutes(m)}
                      >
                        {m} min
                      </button>
                    ))}
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <input
                        type="number"
                        min="1"
                        max="300"
                        value={codingMinutes}
                        onChange={(e) => setCodingMinutes(Math.max(1, Number(e.target.value)))}
                        style={{ width: "55px", height: "24px", padding: "0 6px", fontSize: "12px" }}
                        className="admin-input"
                      />
                      <span className="faint" style={{ fontSize: "12px" }}>m</span>
                    </div>
                  </div>
                  <button
                    className="btn btn-gold btn-block"
                    onClick={() => handleSetPhase("coding", codingMinutes)}
                  >
                    <IconPlay size={14} /> Start Coding Round ({codingMinutes} min)
                  </button>
                </div>
              )}

              {phase === "coding" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <div className="admin-timer-display">
                    <span className="admin-timer-digits">
                      {secondsLeft !== null ? formatClock(secondsLeft) : "--:--"}
                    </span>
                    <span className="admin-timer-label">
                      {secondsLeft && secondsLeft <= 0 ? "(Grace period)" : "remaining"}
                    </span>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span className="faint" style={{ fontSize: "11px", textTransform: "uppercase" }}>Adjust Timer:</span>
                    <div className="btn-group">
                      {EXTEND_MINUTES.map((m) => (
                        <button key={m} className="btn btn-xs" onClick={() => handleExtend(m)}>
                          {m > 0 ? `+${m}m` : `${m}m`}
                        </button>
                      ))}
                      <div style={{ display: "inline-flex", gap: 4 }}>
                        <input
                          type="number"
                          placeholder="mins"
                          value={customExtend}
                          onChange={(e) => setCustomExtend(e.target.value)}
                          style={{ width: "52px", height: "24px", fontSize: "12px" }}
                          className="admin-input"
                        />
                        <button
                          className="btn btn-xs"
                          disabled={!customExtend}
                          onClick={() => {
                            handleExtend(customExtend);
                            setCustomExtend("");
                          }}
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  </div>

                  <div style={{ marginTop: "4px" }}>
                    <button className="btn btn-block" onClick={() => handleSetPhase("locked")}>
                      <IconLock size={14} /> Lock Submissions Now
                    </button>
                  </div>
                </div>
              )}

              {phase === "locked" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <p className="muted" style={{ margin: 0, fontSize: "13px" }}>
                    Submissions are locked. Participants can still test bots. You can advance to the tournament or reopen coding.
                  </p>
                  <div className="btn-group">
                    <button className="btn btn-sm btn-gold" onClick={() => handleSetPhase("tournament")}>
                      Advance to Tournament
                    </button>
                    <button className="btn btn-sm" onClick={() => handleExtend(5)}>
                      Reopen Coding (+5m)
                    </button>
                    <button className="btn btn-sm btn-quiet" onClick={() => handleSetPhase("registration")}>
                      Reset to Registration
                    </button>
                  </div>
                </div>
              )}

              {phase === "tournament" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <p className="muted" style={{ margin: 0, fontSize: "13px" }}>
                    Event is in Tournament phase. Submissions and tests are locked.
                  </p>
                  <div className="btn-group">
                    <button className="btn btn-sm" onClick={() => handleSetPhase("locked")}>
                      Revert to Locked
                    </button>
                    <button className="btn btn-sm btn-quiet" onClick={() => handleSetPhase("registration")}>
                      Reset to Registration
                    </button>
                  </div>
                </div>
              )}

              {/* Force Phase Selector */}
              <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span className="faint" style={{ fontSize: "11px" }}>Override phase:</span>
                <div className="btn-group">
                  {["registration", "coding", "locked", "tournament"].map((p) => (
                    <button
                      key={p}
                      className={`btn btn-xs btn-quiet ${phase === p ? "active" : ""}`}
                      onClick={() => {
                        if (p === "coding") handleSetPhase("coding", 25);
                        else handleSetPhase(p);
                      }}
                      style={{ fontSize: "11px", padding: "0 6px" }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Box 2: Announcement & Quick Actions */}
            <div className="admin-box">
              <span className="admin-box-title">Participant Announcement Banner</span>
              {status && status.announcement ? (
                <div className="admin-announcement-banner">
                  <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                    <IconMegaphone size={16} />
                    <span style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                      {status.announcement}
                    </span>
                  </div>
                  <button className="icon-btn icon-btn-sm" onClick={handleClearAnnounce} title="Clear Banner">
                    <IconClose size={13} />
                  </button>
                </div>
              ) : (
                <p className="faint" style={{ margin: 0, fontSize: "12.5px" }}>
                  No active announcement. Broadcast messages to participants' headers below:
                </p>
              )}

              <form onSubmit={handleAnnounce} className="admin-input-group">
                <input
                  type="text"
                  maxLength={200}
                  placeholder="e.g. 5 minutes remaining! Test before submitting."
                  value={announcementInput}
                  onChange={(e) => setAnnouncementInput(e.target.value)}
                  className="admin-input grow"
                />
                <button type="submit" className="btn btn-sm btn-gold" disabled={!announcementInput.trim()}>
                  Broadcast
                </button>
              </form>

              <div style={{ marginTop: "auto", paddingTop: "8px", borderTop: "1px solid var(--line)" }}>
                <span className="faint" style={{ fontSize: "11.5px" }}>
                  Announcements update in real time across all active participant browser tabs.
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Main Tabs */}
        <div className="admin-tabs">
          <button
            className={`admin-tab ${tab === "participants" ? "active" : ""}`}
            onClick={() => setTab("participants")}
          >
            <IconUser size={15} /> Participants
            <span className="admin-tab-count">{participants.length}</span>
          </button>
          <button
            className={`admin-tab ${tab === "entries" ? "active" : ""}`}
            onClick={() => setTab("entries")}
          >
            <IconCode size={15} /> Tournament Entries
            <span className="admin-tab-count">{entries.length}</span>
          </button>
          <button
            className={`admin-tab ${tab === "ai" ? "active" : ""}`}
            onClick={() => setTab("ai")}
          >
            <IconSpark size={15} /> AI Usage & Logs
            {aiUsage && <span className="admin-tab-count">{aiUsage.requests}</span>}
          </button>
        </div>

        {/* TAB 1: PARTICIPANTS */}
        {tab === "participants" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="admin-stats-row">
              <div className="admin-stat-card">
                <span className="admin-stat-num">{participants.length}</span>
                <span className="admin-stat-label">Total Registered</span>
              </div>
              <div className="admin-stat-card">
                <span className="admin-stat-num" style={{ color: "var(--green)" }}>
                  {participants.filter((p) => p.entry_id != null).length}
                </span>
                <span className="admin-stat-label">Valid Entries</span>
              </div>
              <div className="admin-stat-card">
                <span className="admin-stat-num" style={{ color: "var(--amber)" }}>
                  {participants.filter((p) => p.last_status === "warning").length}
                </span>
                <span className="admin-stat-label">Warnings / Crashes</span>
              </div>
              <div className="admin-stat-card">
                <span className="admin-stat-num" style={{ color: "var(--muted)" }}>
                  {participants.filter((p) => p.submissions === 0).length}
                </span>
                <span className="admin-stat-label">No Submissions</span>
              </div>
            </div>

            <div className="admin-table-container">
              <div className="admin-table-toolbar">
                <div className="admin-search-box">
                  <IconSearch size={14} />
                  <input
                    type="text"
                    placeholder="Search roll or name..."
                    value={participantSearch}
                    onChange={(e) => setParticipantSearch(e.target.value)}
                  />
                  {participantSearch && (
                    <button className="icon-btn icon-btn-sm" onClick={() => setParticipantSearch("")}>
                      <IconClose size={12} />
                    </button>
                  )}
                </div>

                <div className="btn-group">
                  <span className="faint" style={{ fontSize: "12px" }}>Filter:</span>
                  {["all", "has_entry", "no_entry", "warning"].map((f) => (
                    <button
                      key={f}
                      className={`btn btn-xs ${participantFilter === f ? "btn-gold" : "btn-quiet"}`}
                      onClick={() => setParticipantFilter(f)}
                    >
                      {f.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ overflowX: "auto" }}>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th style={{ width: "60px" }}>ID</th>
                      <th>Roll</th>
                      <th>Name</th>
                      <th>Bot Name</th>
                      <th>Submissions</th>
                      <th>Entry Status</th>
                      <th>Registered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredParticipants.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="center muted" style={{ padding: "30px" }}>
                          No participants found.
                        </td>
                      </tr>
                    ) : (
                      filteredParticipants.map((p) => (
                        <tr key={p.id}>
                          <td className="faint">{p.id}</td>
                          <td><code>{p.roll}</code></td>
                          <td style={{ fontWeight: 550 }}>{p.name}</td>
                          <td style={{ color: "var(--gold)" }}>{p.bot_name || "--"}</td>
                          <td>{p.submissions}</td>
                          <td>
                            {p.entry_id ? (
                              <span className={`admin-badge badge-${p.last_status || "ok"}`}>
                                {p.last_status || "entry ready"}
                              </span>
                            ) : p.submissions > 0 ? (
                              <span className="admin-badge badge-rejected">rejected</span>
                            ) : (
                              <span className="admin-badge badge-none">none</span>
                            )}
                          </td>
                          <td className="faint" style={{ fontSize: "12px" }}>
                            {p.created_at ? new Date(p.created_at * 1000).toLocaleTimeString() : "--"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: TOURNAMENT ENTRIES */}
        {tab === "entries" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="admin-stats-row">
              <div className="admin-stat-card">
                <span className="admin-stat-num" style={{ color: "var(--gold-2)" }}>{entries.length}</span>
                <span className="admin-stat-label">Total Entries Ready</span>
              </div>
              <div className="admin-stat-card">
                <span className="admin-stat-num" style={{ color: "var(--green)" }}>
                  {entries.filter((e) => e.status === "ok").length}
                </span>
                <span className="admin-stat-label">Status OK</span>
              </div>
              <div className="admin-stat-card">
                <span className="admin-stat-num" style={{ color: "var(--amber)" }}>
                  {entries.filter((e) => e.status === "warning").length}
                </span>
                <span className="admin-stat-label">Warnings</span>
              </div>
            </div>

            <div className="admin-table-container">
              <div className="admin-table-toolbar">
                <div className="admin-search-box">
                  <IconSearch size={14} />
                  <input
                    type="text"
                    placeholder="Search by roll or name..."
                    value={entriesSearch}
                    onChange={(e) => setEntriesSearch(e.target.value)}
                  />
                </div>

                <button className="btn btn-sm btn-gold" onClick={downloadEntriesJson} disabled={entries.length === 0}>
                  <IconDownload size={14} /> Export All Entries (JSON)
                </button>
              </div>

              <div style={{ overflowX: "auto" }}>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Roll</th>
                      <th>Name</th>
                      <th>Bot Name</th>
                      <th>Sub ID</th>
                      <th>Status</th>
                      <th>Submitted At</th>
                      <th style={{ textAlign: "right" }}>Bot Code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEntries.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="center muted" style={{ padding: "30px" }}>
                          No tournament entries submitted yet.
                        </td>
                      </tr>
                    ) : (
                      filteredEntries.map((e) => (
                        <tr key={e.submission_id}>
                          <td><code>{e.roll}</code></td>
                          <td style={{ fontWeight: 550 }}>{e.name}</td>
                          <td style={{ color: "var(--gold)" }}>{e.bot_name || "--"}</td>
                          <td className="faint">#{e.submission_id}</td>
                          <td>
                            <span className={`admin-badge badge-${e.status}`}>
                              {e.status}
                            </span>
                          </td>
                          <td className="faint" style={{ fontSize: "12px" }}>
                            {e.created_at ? new Date(e.created_at * 1000).toLocaleTimeString() : "--"}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <div className="btn-group" style={{ justifyContent: "flex-end" }}>
                              <button
                                className="btn btn-xs"
                                onClick={() => setInspectedEntry(e)}
                              >
                                View Code
                              </button>
                              <button
                                className="icon-btn icon-btn-sm"
                                onClick={() => downloadSingleBot(e.roll, e.code)}
                                title="Download .py file"
                              >
                                <IconDownload size={13} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: AI USAGE & LOGS */}
        {tab === "ai" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {aiUsage && (
              <div className="admin-card" style={{ padding: "16px 20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                  <span className="admin-card-title">AI Token Budget</span>
                  <span className="muted" style={{ fontSize: "13px", fontFamily: "var(--mono)" }}>
                    {Math.round(aiUsage.spent).toLocaleString()} / {aiUsage.budget.toLocaleString()} units ({((aiUsage.spent / aiUsage.budget) * 100).toFixed(2)}%)
                  </span>
                </div>
                <div className="admin-progress-track">
                  <div
                    className="admin-progress-bar"
                    style={{ width: `${Math.min(100, (aiUsage.spent / aiUsage.budget) * 100)}%` }}
                  />
                </div>
                <div className="admin-stats-row" style={{ marginTop: 14 }}>
                  <div className="admin-stat-card">
                    <span className="admin-stat-num">{aiUsage.requests}</span>
                    <span className="admin-stat-label">AI Requests</span>
                  </div>
                  <div className="admin-stat-card">
                    <span className="admin-stat-num" style={{ color: "var(--green)" }}>
                      {aiUsage.by_status?.ok || 0}
                    </span>
                    <span className="admin-stat-label">Accepted (OK)</span>
                  </div>
                  <div className="admin-stat-card">
                    <span className="admin-stat-num" style={{ color: "var(--amber)" }}>
                      {aiUsage.by_status?.declined || 0}
                    </span>
                    <span className="admin-stat-label">Declined</span>
                  </div>
                  <div className="admin-stat-card">
                    <span className="admin-stat-num">
                      {aiUsage.avg_ms ? `${(aiUsage.avg_ms / 1000).toFixed(2)}s` : "--"}
                    </span>
                    <span className="admin-stat-label">Avg Latency</span>
                  </div>
                </div>
              </div>
            )}

            <div className="admin-table-container">
              <div className="admin-table-toolbar">
                <span className="admin-box-title">Recent AI Calls</span>
                <div className="btn-group">
                  <span className="faint" style={{ fontSize: "12px" }}>Filter:</span>
                  {["all", "declined", "error", "ok"].map((st) => (
                    <button
                      key={st}
                      className={`btn btn-xs ${aiFilter === st ? "btn-gold" : "btn-quiet"}`}
                      onClick={() => setAiFilter(st)}
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ overflowX: "auto" }}>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Roll</th>
                      <th>Status</th>
                      <th>Duration</th>
                      <th>Tokens</th>
                      <th style={{ textAlign: "right" }}>Inspect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAi.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="center muted" style={{ padding: "30px" }}>
                          No AI requests logged yet.
                        </td>
                      </tr>
                    ) : (
                      filteredAi.map((req) => (
                        <tr key={req.id}>
                          <td className="faint" style={{ fontSize: "12px" }}>
                            {req.created_at ? new Date(req.created_at * 1000).toLocaleTimeString() : "--"}
                          </td>
                          <td><code>{req.roll}</code></td>
                          <td>
                            <span className={`admin-badge badge-${req.status}`}>
                              {req.status}
                            </span>
                          </td>
                          <td className="faint">{req.ms ? `${req.ms} ms` : "--"}</td>
                          <td className="faint" style={{ fontFamily: "var(--mono)", fontSize: "12px" }}>
                            {req.prompt_tokens + req.completion_tokens}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <button
                              className="btn btn-xs"
                              onClick={() => setInspectedAi(req)}
                            >
                              Inspect
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>


      {/* MODAL: View Entry Code */}
      {inspectedEntry && (
        <div className="admin-modal-backdrop" onClick={() => setInspectedEntry(null)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-header">
              <div>
                <span className="admin-card-title">
                  {inspectedEntry.name} (<code>{inspectedEntry.roll}</code>)
                </span>
                <span className="faint" style={{ fontSize: "12px", marginLeft: 8 }}>
                  Submission #{inspectedEntry.submission_id} • Status: {inspectedEntry.status}
                </span>
              </div>
              <button className="icon-btn icon-btn-sm" onClick={() => setInspectedEntry(null)}>
                <IconClose size={14} />
              </button>
            </div>
            <div className="admin-modal-body">
              <pre className="admin-code-block">{inspectedEntry.code}</pre>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <button
                  className="btn btn-sm btn-gold"
                  onClick={() => copyToClipboard(inspectedEntry.code)}
                >
                  <IconCopy size={13} /> {copiedText ? "Copied!" : "Copy Code"}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => downloadSingleBot(inspectedEntry.roll, inspectedEntry.code)}
                >
                  <IconDownload size={13} /> Download .py
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Inspect AI Request */}
      {inspectedAi && (
        <div className="admin-modal-backdrop" onClick={() => setInspectedAi(null)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-header">
              <span className="admin-card-title">
                AI Call #{inspectedAi.id} - <code>{inspectedAi.roll}</code> ({inspectedAi.status})
              </span>
              <button className="icon-btn icon-btn-sm" onClick={() => setInspectedAi(null)}>
                <IconClose size={14} />
              </button>
            </div>
            <div className="admin-modal-body">
              <div>
                <span className="eyebrow" style={{ display: "block", marginBottom: 6 }}>Participant Pseudocode:</span>
                <pre className="admin-code-block" style={{ maxHeight: 180 }}>{inspectedAi.pseudocode}</pre>
              </div>

              <div>
                <span className="eyebrow" style={{ display: "block", marginBottom: 6 }}>AI Translation / Response:</span>
                <pre className="admin-code-block" style={{ maxHeight: 220 }}>
                  {(() => {
                    try {
                      const res = typeof inspectedAi.response === "string" ? JSON.parse(inspectedAi.response) : inspectedAi.response;
                      if (res && res.code) return res.code;
                      if (res && res.issues) return JSON.stringify(res.issues, null, 2);
                      return inspectedAi.raw || JSON.stringify(res, null, 2);
                    } catch {
                      return inspectedAi.raw || inspectedAi.response || "(empty)";
                    }
                  })()}
                </pre>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }} className="faint">
                <span>Duration: {inspectedAi.ms} ms</span>
                <span>Tokens: {inspectedAi.prompt_tokens} in / {inspectedAi.completion_tokens} out</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
