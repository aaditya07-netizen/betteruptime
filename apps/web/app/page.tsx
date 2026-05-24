"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";

type AuthMode = "signin" | "signup";
type SiteStatus = "Up" | "Down" | "Unknown";

type TrackedSite = {
  id: string;
  url: string;
  status: SiteStatus;
  responseTimeMs: number | null;
  checkedAt: string | null;
};

type StatusResponse = {
  id: string;
  url: string;
  user_id: string;
  latest_tick: {
    response_time_ms: number;
    status: SiteStatus;
    createdAt: string;
  } | null;
};

const STORAGE_KEY = "betterstack.web.state";

function initialUsername() {
  return `user-${Math.random().toString(36).slice(2, 8)}`;
}

function statusLabel(site: TrackedSite) {
  if (site.status === "Unknown") {
    return "Waiting";
  }

  return site.status;
}

export default function Home() {
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("password123");
  const [token, setToken] = useState("");
  const [userId, setUserId] = useState("");
  const [url, setUrl] = useState("https://google.com");
  const [manualWebsiteId, setManualWebsiteId] = useState("");
  const [sites, setSites] = useState<TrackedSite[]>([]);
  const [message, setMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      return;
    }

    try {
      const parsed = JSON.parse(saved) as {
        token?: string;
        userId?: string;
        sites?: TrackedSite[];
      };

      setToken(parsed.token ?? "");
      setUserId(parsed.userId ?? "");
      setSites(parsed.sites ?? []);
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token,
        userId,
        sites,
      }),
    );
  }, [token, userId, sites]);

  const summary = useMemo(() => {
    const up = sites.filter((site) => site.status === "Up").length;
    const down = sites.filter((site) => site.status === "Down").length;
    const waiting = sites.length - up - down;

    return { up, down, waiting };
  }, [sites]);

  async function request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(path, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: token } : {}),
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsBusy(true);
    setMessage("");

    try {
      if (authMode === "signup") {
        const createdUser = await request<{ id: string }>("/api/auth/signup", {
          method: "POST",
          body: JSON.stringify({ username, password }),
        });
        setUserId(createdUser.id);
      }

      const signedIn = await request<{ jwt: string }>("/api/auth/signin", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      setToken(signedIn.jwt);
      setMessage(authMode === "signup" ? "Account created and signed in." : "Signed in.");
    } catch {
      setMessage("Auth failed. Check the backend and credentials.");
    } finally {
      setIsBusy(false);
    }
  }

  async function addWebsite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!token) {
      setMessage("Sign in before adding a website.");
      return;
    }

    setIsBusy(true);
    setMessage("");

    try {
      const created = await request<{ id: string }>("/api/websites", {
        method: "POST",
        body: JSON.stringify({ url }),
      });

      setSites((current) => [
        {
          id: created.id,
          url,
          status: "Unknown",
          responseTimeMs: null,
          checkedAt: null,
        },
        ...current.filter((site) => site.id !== created.id),
      ]);
      setManualWebsiteId(created.id);
      setMessage("Website added. Run the pusher and worker to collect ticks.");
    } catch {
      setMessage("Could not add website. Use a full URL such as https://example.com.");
    } finally {
      setIsBusy(false);
    }
  }

  async function refreshStatus(websiteId: string) {
    if (!token) {
      setMessage("Sign in before checking status.");
      return;
    }

    setIsBusy(true);
    setMessage("");

    try {
      const status = await request<StatusResponse>(`/api/status/${websiteId}`);
      const nextSite: TrackedSite = {
        id: status.id,
        url: status.url,
        status: status.latest_tick?.status ?? "Unknown",
        responseTimeMs: status.latest_tick?.response_time_ms ?? null,
        checkedAt: status.latest_tick?.createdAt ?? null,
      };

      setSites((current) => [
        nextSite,
        ...current.filter((site) => site.id !== status.id),
      ]);
      setMessage("Status refreshed.");
    } catch {
      setMessage("Could not fetch that website for this user.");
    } finally {
      setIsBusy(false);
    }
  }

  function signOut() {
    setToken("");
    setUserId("");
    setSites([]);
    setMessage("Signed out locally.");
  }

  return (
    <main className={styles.shell}>
      <section className={styles.topbar} aria-label="Workspace summary">
        <div>
          <p className={styles.eyebrow}>BetterStack Monitor</p>
          <h1>Uptime checks from your monorepo backend</h1>
        </div>
        <div className={styles.connection}>
          <span className={token ? styles.liveDot : styles.offlineDot} />
          {token ? "Signed in" : "Signed out"}
        </div>
      </section>

      <section className={styles.metrics} aria-label="Status counts">
        <div>
          <span>{sites.length}</span>
          <p>Sites</p>
        </div>
        <div>
          <span>{summary.up}</span>
          <p>Up</p>
        </div>
        <div>
          <span>{summary.down}</span>
          <p>Down</p>
        </div>
        <div>
          <span>{summary.waiting}</span>
          <p>Waiting</p>
        </div>
      </section>

      <div className={styles.workspace}>
        <aside className={styles.controlPanel} aria-label="Controls">
          <form className={styles.form} onSubmit={handleAuth}>
            <div className={styles.segmented} role="tablist" aria-label="Auth mode">
              <button
                type="button"
                className={authMode === "signup" ? styles.activeSegment : ""}
                onClick={() => setAuthMode("signup")}
              >
                Sign up
              </button>
              <button
                type="button"
                className={authMode === "signin" ? styles.activeSegment : ""}
                onClick={() => setAuthMode("signin")}
              >
                Sign in
              </button>
            </div>

            <label>
              Username
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
              />
            </label>
            <label>
              Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                autoComplete={authMode === "signup" ? "new-password" : "current-password"}
              />
            </label>

            <button className={styles.primaryButton} disabled={isBusy}>
              {authMode === "signup" ? "Create account" : "Sign in"}
            </button>

            {token ? (
              <button className={styles.secondaryButton} type="button" onClick={signOut}>
                Sign out
              </button>
            ) : null}
          </form>

          <form className={styles.form} onSubmit={addWebsite}>
            <label>
              Website URL
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com"
                inputMode="url"
              />
            </label>
            <button className={styles.primaryButton} disabled={isBusy || !token}>
              Add website
            </button>
          </form>

          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void refreshStatus(manualWebsiteId);
            }}
          >
            <label>
              Website ID
              <input
                value={manualWebsiteId}
                onChange={(event) => setManualWebsiteId(event.target.value)}
                placeholder="Paste an existing website id"
              />
            </label>
            <button className={styles.secondaryButton} disabled={isBusy || !manualWebsiteId}>
              Check status
            </button>
          </form>

          {message ? <p className={styles.message}>{message}</p> : null}
          {userId ? <p className={styles.meta}>User id: {userId}</p> : null}
        </aside>

        <section className={styles.monitor} aria-label="Tracked websites">
          <div className={styles.monitorHeader}>
            <div>
              <p className={styles.eyebrow}>Live Workspace</p>
              <h2>Tracked websites</h2>
            </div>
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={isBusy || sites.length === 0}
              onClick={() => {
                void Promise.all(sites.map((site) => refreshStatus(site.id)));
              }}
            >
              Refresh all
            </button>
          </div>

          {sites.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.pulsePreview} aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </div>
              <p>Add a website to begin tracking its latest uptime tick.</p>
            </div>
          ) : (
            <div className={styles.siteList}>
              {sites.map((site) => (
                <article className={styles.siteCard} key={site.id}>
                  <div className={styles.statusRail} data-status={site.status} />
                  <div className={styles.siteMain}>
                    <div>
                      <h3>{site.url}</h3>
                      <p>{site.id}</p>
                    </div>
                    <div className={styles.siteActions}>
                      <span data-status={site.status}>{statusLabel(site)}</span>
                      <button
                        className={styles.iconButton}
                        type="button"
                        title="Refresh status"
                        aria-label={`Refresh ${site.url}`}
                        disabled={isBusy}
                        onClick={() => refreshStatus(site.id)}
                      >
                        ↻
                      </button>
                    </div>
                  </div>
                  <div className={styles.siteMeta}>
                    <span>
                      {site.responseTimeMs === null ? "No response time" : `${site.responseTimeMs} ms`}
                    </span>
                    <span>
                      {site.checkedAt
                        ? new Intl.DateTimeFormat(undefined, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }).format(new Date(site.checkedAt))
                        : "No tick yet"}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
