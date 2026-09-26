import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken, setUnauthorizedHandler } from "./api";
import { useEventStatus } from "./hooks";
import { startEngine } from "./local/engine";
import Register from "./components/Register";
import Workspace from "./components/Workspace";

export default function App() {
  const [token, setTok] = useState(getToken());
  const [me, setMe] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [info, setInfo] = useState({ starter: null, houseBots: [], rules: null });
  const { status, offline, refresh } = useEventStatus();

  const signOut = useCallback(() => {
    setToken(null);
    setTok(null);
    setMe(null);
  }, []);

  useEffect(() => setUnauthorizedHandler(signOut), [signOut]);

  // Start downloading the local tester right away, so it's ready by the time they need it.
  useEffect(() => {
    const t = setTimeout(startEngine, 300);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    Promise.all([api("/api/starter"), api("/api/house-bots"), api("/api/rules")])
      .then(([starter, houseBots, rules]) => setInfo({ starter, houseBots, rules }))
      .catch((e) => setLoadError(e.message));
  }, []);

  const refreshMe = useCallback(() => {
    if (!token) return;
    api("/api/me", { token }).then(setMe, (e) => e.status !== 401 && setLoadError(e.message));
  }, [token]);

  useEffect(refreshMe, [refreshMe]);

  if (!token) {
    return (
      <Register
        status={status}
        onDone={(t) => {
          setToken(t);
          setTok(t);
          setLoadError("");
        }}
      />
    );
  }

  if (!me || !info.starter) {
    return (
      <div className="loading-page">
        {loadError ? (
          <>
            <p>{loadError}</p>
            <button className="btn" onClick={() => window.location.reload()}>Try again</button>
          </>
        ) : (
          <><span className="spinner" /> Loading</>
        )}
      </div>
    );
  }

  return (
    <Workspace
      me={me}
      status={status}
      offline={offline}
      refreshStatus={refresh}
      refreshMe={refreshMe}
      onSignOut={signOut}
      {...info}
    />
  );
}
