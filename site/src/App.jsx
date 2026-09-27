import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken, setUnauthorizedHandler } from "./api";
import { useEventStatus } from "./hooks";
import { startEngine } from "./local/engine";
import Register from "./components/Register";
import Workspace from "./components/Workspace";
import Admin from "./components/Admin";
import BigScreen from "./components/tournament/BigScreen";

const checkIsAdmin = () =>
  typeof window !== "undefined" &&
  (window.location.pathname.startsWith("/admin") ||
    window.location.hash.startsWith("#admin") ||
    new URLSearchParams(window.location.search).has("admin"));

const checkIsScreen = () =>
  typeof window !== "undefined" &&
  (window.location.pathname.startsWith("/screen") ||
    window.location.hash.startsWith("#screen") ||
    new URLSearchParams(window.location.search).has("screen"));

export default function App() {
  const [isAdmin, setIsAdmin] = useState(checkIsAdmin);
  const [isScreen, setIsScreen] = useState(checkIsScreen);
  const [token, setTok] = useState(getToken());
  const [me, setMe] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [info, setInfo] = useState({ starter: null, houseBots: [], rules: null });
  const { status, offline, refresh } = useEventStatus();

  useEffect(() => {
    const onNav = () => {
      setIsAdmin(checkIsAdmin());
      setIsScreen(checkIsScreen());
    };
    window.addEventListener("hashchange", onNav);
    window.addEventListener("popstate", onNav);
    return () => {
      window.removeEventListener("hashchange", onNav);
      window.removeEventListener("popstate", onNav);
    };
  }, []);

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

  if (isScreen) {
    return (
      <BigScreen
        onExit={() => {
          if (window.location.pathname.startsWith("/screen")) {
            window.location.href = "/";
          } else {
            window.location.hash = "";
            setIsScreen(false);
          }
        }}
      />
    );
  }

  if (isAdmin) {
    return (
      <Admin
        onExit={() => {
          if (window.location.pathname.startsWith("/admin")) {
            window.location.href = "/";
          } else {
            window.location.hash = "";
            setIsAdmin(false);
          }
        }}
      />
    );
  }

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
