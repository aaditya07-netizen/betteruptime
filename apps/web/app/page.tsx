"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import styles from "./page.module.css";

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

type WebsitesResponse = {
  websites: StatusResponse[];
};

function statusLabel(site: TrackedSite) {
  if (site.status === "Unknown") {
    return "Waiting";
  }

  return site.status;
}

function normalizeSite(site: StatusResponse): TrackedSite {
  return {
    id: site.id,
    url: site.url,
    status: site.latest_tick?.status ?? "Unknown",
    responseTimeMs: site.latest_tick?.response_time_ms ?? null,
    checkedAt: site.latest_tick?.createdAt ?? null,
  };
}

export default function Home() {
  const { data: session, status: authStatus } = useSession();
  const backendToken = session?.backendJwt ?? "";
  const userId = session?.backendUserId ?? "";
  const isSignedIn = authStatus === "authenticated" && Boolean(backendToken);

  const [url, setUrl] = useState("https://google.com");
  const [manualWebsiteId, setManualWebsiteId] = useState("");
  const [sites, setSites] = useState<TrackedSite[]>([]);
  const [message, setMessage] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const summary = useMemo(() => {
    const up = sites.filter((site) => site.status === "Up").length;
    const down = sites.filter((site) => site.status === "Down").length;
    const waiting = sites.length - up - down;

    return { up, down, waiting };
  }, [sites]);

  const request = useCallback(async <T,>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> => {
    const response = await fetch(path, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(backendToken ? { authorization: `Bearer ${backendToken}` } : {}),
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    return response.json() as Promise<T>;
  }, [backendToken]);

  const loadWebsites = useCallback(async (successMessage?: string) => {
    if (!backendToken) {
      setSites([]);
      return;
    }

    setIsBusy(true);
    setMessage("");

    try {
      const response = await request<WebsitesResponse>("/api/websites");
      setSites(response.websites.map(normalizeSite));

      if (successMessage) {
        setMessage(successMessage);
      }
    } catch {
      setMessage("Could not load your saved websites.");
    } finally {
      setIsBusy(false);
    }
  }, [backendToken, request]);

  useEffect(() => {
    if (authStatus === "loading") {
      return;
    }

    if (!backendToken) {
      setSites([]);
      return;
    }

    void loadWebsites();
  }, [authStatus, backendToken, loadWebsites]);

  async function addWebsite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!backendToken) {
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
      setMessage("Website added. It will still be here after you sign back in.");
    } catch {
      setMessage("Could not add website. Use a full URL such as https://example.com.");
    } finally {
      setIsBusy(false);
    }
  }

  async function refreshStatus(websiteId: string) {
    if (!backendToken) {
      setMessage("Sign in before checking status.");
      return;
    }

    setIsBusy(true);
    setMessage("");

    try {
      const status = await request<StatusResponse>(`/api/status/${websiteId}`);
      const nextSite = normalizeSite(status);

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

  function handleSignOut() {
    setSites([]);
    setManualWebsiteId("");
    setMessage("");
    void signOut({ callbackUrl: "/" });
  }

  return (
    <main className={styles.shell}>
      <section className={styles.topbar} aria-label="Workspace summary">
        <div>
          <p className={styles.eyebrow}>BetterStack Monitor</p>
          <h1>Uptime checks from your monorepo backend</h1>
        </div>
        <div className={styles.connection}>
          <span className={isSignedIn ? styles.liveDot : styles.offlineDot} />
          {isSignedIn ? "Signed in" : "Signed out"}
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
          <section className={styles.authSummary} aria-label="Account">
            <div>
              <p className={styles.eyebrow}>Account</p>
              <h2>{session?.user?.name ?? "Google sign in"}</h2>
              <p>{session?.user?.email ?? "Use Google to save websites to your account."}</p>
            </div>

            {isSignedIn ? (
              <button className={styles.secondaryButton} type="button" onClick={handleSignOut}>
                Sign out
              </button>
            ) : (
              <button
                className={styles.primaryButton}
                type="button"
                disabled={authStatus === "loading"}
                onClick={() => void signIn("google", { callbackUrl: "/" })}
              >
                Continue with Google
              </button>
            )}
          </section>

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
            <button className={styles.primaryButton} disabled={isBusy || !isSignedIn}>
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
            <button
              className={styles.secondaryButton}
              disabled={isBusy || !manualWebsiteId || !isSignedIn}
            >
              Check status
            </button>
          </form>

          {session?.error === "BackendAuthFailed" ? (
            <p className={styles.message}>Google signed in, but backend account setup failed.</p>
          ) : null}
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
              disabled={isBusy || !isSignedIn}
              onClick={() => {
                void loadWebsites("Websites refreshed.");
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
              <p>
                {isSignedIn
                  ? "Add a website to begin tracking its latest uptime tick."
                  : "Sign in to load your saved websites."}
              </p>
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
