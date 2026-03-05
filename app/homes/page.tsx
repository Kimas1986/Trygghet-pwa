"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import type { Session } from "@supabase/supabase-js";

type HomeRow = {
  home_id: string;
  home_name?: string | null;

  role: string;
  state: string | null;
  last_seen: string | null; // heartbeat
  last_motion: string | null; // motion
  battery_low: boolean | null;

  latest_open_alert: null | {
    alert_id: string;
    type: string | null;
    window: string | null;
    triggered_at: string | null;
  };

  latest_alert?: null | {
    alert_id: string;
    type: string | null;
    window: string | null;
    triggered_at: string | null;
    acknowledged: boolean;
    acknowledged_at: string | null;
    ack_by: string | null;
  };

  last_checked: null | {
    acknowledged_at: string | null;
    ack_by: string | null;
  };
};

function formatDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function timeAgo(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);

  if (min < 1) return "akkurat nå";
  if (min < 60) return `${min} min siden`;

  const h = Math.floor(min / 60);
  if (h < 24) return `${h} t siden`;

  const days = Math.floor(h / 24);
  return `${days} d siden`;
}

function stateMeta(state: string | null) {
  const s = (state || "").toLowerCase();

  if (s === "red") {
    return {
      label: "Rød",
      dot: "bg-red-700",
      card: "border-red-400 bg-red-50",
      ring: "ring-red-200",
      title: "text-red-950",
      sub: "text-red-900/80",
      pill: "bg-white/80 border-red-300 text-red-900",
      bar: "bg-red-700",
      cta: "bg-red-700 hover:bg-red-800 text-white",
    };
  }

  if (s === "green") {
    return {
      label: "Grønn",
      dot: "bg-green-600",
      card: "border-green-200 bg-green-50",
      ring: "ring-green-100",
      title: "text-green-950",
      sub: "text-green-900/80",
      pill: "bg-white/70 border-green-200 text-green-900",
      bar: "bg-green-600",
      cta: "bg-gray-900 hover:bg-gray-800 text-white",
    };
  }

  return {
    label: "Grå",
    dot: "bg-gray-400",
    card: "border-gray-200 bg-white",
    ring: "ring-gray-100",
    title: "text-gray-900",
    sub: "text-gray-700",
    pill: "bg-gray-50 border-gray-200 text-gray-700",
    bar: "bg-gray-300",
    cta: "bg-gray-900 hover:bg-gray-800 text-white",
  };
}

function isSystemOnline(lastSeenIso: string | null) {
  if (!lastSeenIso) return false;
  const d = new Date(lastSeenIso);
  if (Number.isNaN(d.getTime())) return false;

  // Heartbeat innen 90 min => online (juster om du vil)
  const minutes = (Date.now() - d.getTime()) / 60000;
  return minutes <= 90;
}

// ✅ PWA install prompt typing (Chrome/Edge/Android)
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

function isIos() {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod/.test(ua);
}

function isInStandaloneMode() {
  if (typeof window === "undefined") return false;
  // iOS Safari:
  const nav = window.navigator as any;
  const iOSStandalone = Boolean(nav.standalone);
  // Chrome/Edge:
  const mqStandalone = window.matchMedia?.("(display-mode: standalone)")?.matches;
  return iOSStandalone || Boolean(mqStandalone);
}

export default function HomesPage() {
  const router = useRouter();

  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [homes, setHomes] = useState<HomeRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Invite UI
  const [inviteBusy, setInviteBusy] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteOpenFor, setInviteOpenFor] = useState<string | null>(null);
  const [inviteByHome, setInviteByHome] = useState<Record<string, string>>({});

  // ACK UI
  const [ackBusy, setAckBusy] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);

  // Origin for join-link
  const [origin, setOrigin] = useState<string>("");

  // Avoid double-load
  const didLoad = useRef(false);

  // ✅ PWA install UI state
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    setStandalone(isInStandaloneMode());
    setIos(isIos());

    const onBip = (e: Event) => {
      // stop browser mini-infobar
      e.preventDefault?.();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };

    const onInstalled = () => {
      setInstallEvent(null);
      setStandalone(true);
    };

    window.addEventListener("beforeinstallprompt", onBip as any);
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBip as any);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    let alive = true;

    async function init() {
      setLoading(true);
      setError(null);

      const { data } = await supabase.auth.getSession();
      if (!alive) return;

      const s = data.session ?? null;
      setSession(s);

      if (!s) {
        router.replace("/login");
        return;
      }

      setLoading(false);
    }

    init();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (!newSession) router.replace("/login");
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [router]);

  async function loadHomes() {
    setError(null);

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setHomes([]);
      return;
    }

    const res = await fetch("/api/homes", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(j?.error || `Feil (${res.status})`);
      setHomes([]);
      return;
    }

    setHomes((j?.homes ?? []) as HomeRow[]);
  }

  useEffect(() => {
    if (!session) return;
    if (didLoad.current) return;
    didLoad.current = true;

    loadHomes();
    const t = setInterval(loadHomes, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const hasHomes = homes.length > 0;

  const anyAdmin = useMemo(
    () => homes.some((h) => (h.role || "").toLowerCase() === "admin"),
    [homes]
  );

  async function onLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  function joinUrl(code: string) {
    const base = origin || "";
    return `${base}/join?code=${encodeURIComponent(code)}`;
  }

  async function createInvite(home_id: string) {
    setInviteError(null);
    setInviteBusy(home_id);

    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;

      if (!token) {
        setInviteError("Du er ikke innlogget. Logg inn på nytt.");
        router.replace("/login");
        return;
      }

      const res = await fetch("/api/invites/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ home_id }),
      });

      const j = await res.json().catch(() => ({}));

      if (res.status === 401) {
        setInviteError("Innloggingen din er utløpt. Logg inn på nytt.");
        await supabase.auth.signOut();
        router.replace("/login");
        return;
      }

      if (!res.ok) {
        setInviteError(j?.error || `Invite feilet (${res.status})`);
        return;
      }

      const code = String(j.invite_code ?? "").trim();
      if (!code) {
        setInviteError("Invite feilet: mangler kode fra server");
        return;
      }

      setInviteByHome((prev) => ({ ...prev, [home_id]: code }));
      setInviteOpenFor(home_id);

      try {
        await navigator.clipboard.writeText(joinUrl(code));
      } catch {}
    } finally {
      setInviteBusy(null);
    }
  }

  async function ackAlert(homeId: string, alertId: string) {
    setAckError(null);
    setAckBusy(alertId);

    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;

      if (!token) {
        setAckError("Du er ikke innlogget. Logg inn på nytt.");
        router.replace("/login");
        return;
      }

      // Optimistisk: marker latest_alert som acked i UI med en gang
      const nowIso = new Date().toISOString();
      setHomes((prev) =>
        prev.map((h) => {
          if (h.home_id !== homeId) return h;

          const latest = h.latest_alert;
          if (!latest) return h;

          return {
            ...h,
            latest_alert: {
              ...latest,
              acknowledged: true,
              acknowledged_at: latest.acknowledged_at ?? nowIso,
            },
            last_checked: {
              acknowledged_at: nowIso,
              ack_by: h.last_checked?.ack_by ?? null,
            },
          };
        })
      );

      const res = await fetch(`/api/alerts/${encodeURIComponent(alertId)}/ack`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAckError(j?.error || `ACK feilet (${res.status})`);
        return;
      }

      await loadHomes();
    } finally {
      setAckBusy(null);
    }
  }

  async function onInstallClick() {
    if (!installEvent) return;
    try {
      await installEvent.prompt();
      await installEvent.userChoice;
      // some browsers fire appinstalled, but we also update local state
      setInstallEvent(null);
      setStandalone(isInStandaloneMode());
    } catch {
      // ignore
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 p-4">
        <div className="mx-auto max-w-2xl rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          Laster…
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50">
      {/* Topbar */}
      <div className="sticky top-0 z-10 border-b border-gray-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-gray-900">Trygghet</div>
            <div className="text-xs text-gray-600">Status for hus du følger</div>
          </div>

          <button
            type="button"
            onClick={onLogout}
            className="shrink-0 rounded-xl bg-gray-900 px-3 py-2 text-sm text-white shadow-sm hover:bg-gray-800"
          >
            Logg ut
          </button>
        </div>

        {error && (
          <div className="mx-auto max-w-2xl px-4 pb-3">
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {error}
            </div>
          </div>
        )}

        {ackError && (
          <div className="mx-auto max-w-2xl px-4 pb-3">
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {ackError}
            </div>
          </div>
        )}
      </div>

      <div className="mx-auto max-w-2xl p-4">
        {/* No homes */}
        {!hasHomes && (
          <div className="mb-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-gray-900">Du er ikke koblet til noe hus ennå</h2>
            <p className="mt-1 text-sm text-gray-600">
              Har du fått en invitasjonslink? Den tar deg rett til join.
            </p>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Link
                href="/join"
                className="rounded-xl bg-gray-900 px-4 py-2 text-center text-sm text-white shadow-sm hover:bg-gray-800"
              >
                Legg inn kode
              </Link>

              <Link
                href="/register"
                className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-center text-sm text-gray-900 shadow-sm hover:bg-gray-50"
              >
                Opprett admin (produktkode)
              </Link>
            </div>
          </div>
        )}

        {/* Homes list */}
        {homes.map((h) => {
          const stateLower = (h.state || "").toLowerCase();
          const isRedCard = stateLower === "red";
          const meta = stateMeta(h.state);

          const isAdmin = (h.role || "").toLowerCase() === "admin";
          const isInviteOpen = inviteOpenFor === h.home_id;
          const code = inviteByHome[h.home_id] || "";
          const link = code ? joinUrl(code) : "";

          const motionAgo = timeAgo(h.last_motion);

          const title = (h.home_name || "").trim() || h.home_id;

          const online = isSystemOnline(h.last_seen);

          // ACK-status for “gjeldende rød-periode”
          const latestAlert = h.latest_alert ?? null;
          const canAck = Boolean(latestAlert?.alert_id);
          const isAcked = Boolean(latestAlert?.acknowledged);

          const alertStartedAt = latestAlert?.triggered_at ?? h.latest_open_alert?.triggered_at ?? null;
          const ackedAt = latestAlert?.acknowledged_at ?? h.last_checked?.acknowledged_at ?? null;
          const ackedBy = latestAlert?.ack_by ?? h.last_checked?.ack_by ?? null;

          return (
            <div
              key={h.home_id}
              className={`mb-4 rounded-2xl border p-4 shadow-sm ring-1 ${meta.card} ${meta.ring}`}
            >
              <div className="flex gap-3">
                <div className={`w-2 rounded-full ${meta.bar}`} />

                <div className="min-w-0 flex-1">
                  {/* Header */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} />

                        <div className={`truncate text-base font-semibold ${meta.title}`}>{title}</div>

                        <span className={`rounded-full border px-2 py-0.5 text-xs ${meta.pill}`}>
                          {meta.label}
                        </span>

                        {online ? (
                          <span className="rounded-full bg-green-600 px-2 py-0.5 text-xs font-semibold text-white">
                            System online
                          </span>
                        ) : (
                          <span className="rounded-full bg-gray-700 px-2 py-0.5 text-xs font-semibold text-white">
                            System offline
                          </span>
                        )}

                        {h.battery_low && (
                          <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-white">
                            Lavt batteri
                          </span>
                        )}

                        {(h.role || "").toLowerCase() === "admin" ? (
                          <span className="text-xs text-gray-600">Admin</span>
                        ) : (
                          <span className="text-xs text-gray-600">Viewer</span>
                        )}
                      </div>

                      {/* ✅ Behold kun ID under navn (ingen "sist sjekket" her) */}
                      <div className={`mt-1 text-xs ${meta.sub}`}>
                        ID: <span className="font-mono">{h.home_id}</span>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => {
                          // Placeholder – du har allerede “Endre navn” i UI hos deg, så vi lar den stå her uten logikk.
                          // (Neste steg: vi kobler den til en API-route)
                          alert("Neste steg: vi kobler Endre navn til backend 😊");
                        }}
                        className="rounded-xl border border-gray-200 bg-white/80 px-3 py-2 text-sm text-gray-900 shadow-sm hover:bg-white"
                      >
                        Endre navn
                      </button>

                      <Link
                        href={`/homes/${encodeURIComponent(h.home_id)}`}
                        className="rounded-xl border border-gray-200 bg-white/80 px-3 py-2 text-sm text-gray-900 shadow-sm hover:bg-white"
                      >
                        Se detaljer
                      </Link>

                      {isAdmin && (
                        <button
                          type="button"
                          onClick={() => (isInviteOpen ? setInviteOpenFor(null) : createInvite(h.home_id))}
                          disabled={inviteBusy === h.home_id}
                          className={`rounded-xl px-3 py-2 text-sm shadow-sm disabled:opacity-60 ${meta.cta}`}
                        >
                          {isInviteOpen ? "Skjul" : inviteBusy === h.home_id ? "Lager…" : "Del link"}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* RØD-boks: vises kun på rød kort */}
                  {isRedCard && (
                    <div className="mt-4 rounded-2xl border border-red-400 bg-white/90 p-4 shadow-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-red-900">Viktig: sjekk huset</div>
                          <div className="mt-1 text-sm text-gray-900">
                            Dette huset er rødt. Når du har sjekket, trykk knappen.
                          </div>

                          {alertStartedAt ? (
                            <div className="mt-2 text-xs text-gray-700">
                              Startet: <span className="font-medium">{formatDate(alertStartedAt)}</span>
                            </div>
                          ) : null}

                          {isAcked && ackedAt ? (
                            <div className="mt-2 text-xs text-gray-700">
                              Sjekket: <span className="font-medium">{formatDate(ackedAt)}</span>
                              {ackedBy ? <span className="opacity-80"> ({ackedBy})</span> : null}
                            </div>
                          ) : null}
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            if (!canAck || !latestAlert?.alert_id) return;
                            if (isAcked) return;
                            ackAlert(h.home_id, latestAlert.alert_id);
                          }}
                          disabled={!canAck || isAcked || ackBusy === latestAlert?.alert_id}
                          className={[
                            "shrink-0 rounded-xl px-3 py-2 text-sm font-semibold shadow-sm disabled:opacity-60",
                            isAcked ? "bg-green-600 text-white" : "bg-gray-900 text-white hover:bg-gray-800",
                          ].join(" ")}
                        >
                          {ackBusy === latestAlert?.alert_id ? "Logger…" : isAcked ? "Sjekket!" : "Jeg sjekker"}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Kun "Sist bevegelse" på kortet */}
                  <div className="mt-4 rounded-xl bg-white/80 p-3 ring-1 ring-black/5">
                    <div className="text-xs text-gray-600">Sist bevegelse</div>
                    <div className="mt-1 text-sm font-semibold text-gray-900">{formatDate(h.last_motion)}</div>
                    {motionAgo && <div className="mt-0.5 text-xs text-gray-600">{motionAgo}</div>}
                  </div>

                  {inviteError && (
                    <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                      {inviteError}
                    </div>
                  )}

                  {/* Invite box */}
                  {isAdmin && isInviteOpen && (
                    <div className="mt-4 rounded-2xl border border-gray-200 bg-white/80 p-4 ring-1 ring-black/5">
                      <div className="text-sm text-gray-700">Send linken til pårørende. Koden blir forhåndsutfylt.</div>

                      <div className="mt-3 grid gap-2">
                        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                          <div className="text-xs text-gray-600">Join-link</div>
                          <div className="mt-1 break-all text-sm text-gray-900">{link || "—"}</div>
                        </div>

                        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                          <div className="text-xs text-gray-600">Invitasjonskode</div>
                          <div className="mt-1 font-mono text-base font-semibold tracking-wider text-gray-900">
                            {code || "—"}
                          </div>
                        </div>

                        <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(link);
                              } catch {}
                            }}
                            className="rounded-xl bg-gray-900 px-3 py-2 text-sm text-white shadow-sm hover:bg-gray-800"
                          >
                            Kopier link
                          </button>

                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(code);
                              } catch {}
                            }}
                            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm hover:bg-gray-50"
                          >
                            Kopier kode
                          </button>
                        </div>

                        <div className="text-xs text-gray-500">
                          Tips: lim inn linken i SMS/WhatsApp. Pårørende fyller inn telefon + e-post/passord på join.
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {/* ✅ PWA: “Legg til på hjemskjermen” */}
        {hasHomes && (
          <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold text-gray-900">Legg til på hjemskjermen</div>

            {standalone ? (
              <div className="mt-1 text-sm text-gray-700">Appen er allerede installert ✅</div>
            ) : installEvent ? (
              <>
                <div className="mt-1 text-sm text-gray-700">
                  Legg Trygghet på hjemskjermen for rask tilgang og bedre push-støtte.
                </div>

                <button
                  type="button"
                  onClick={onInstallClick}
                  className="mt-3 rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-800"
                >
                  Legg til som app
                </button>
              </>
            ) : ios ? (
              <div className="mt-1 text-sm text-gray-700">
                På iPhone/iPad: Trykk <span className="font-semibold">Del</span> →{" "}
                <span className="font-semibold">Legg til på Hjem-skjerm</span>.
              </div>
            ) : (
              <div className="mt-1 text-sm text-gray-700">
                Hvis du ikke får opp install-knapp: åpne nettleser-menyen (⋯) og velg{" "}
                <span className="font-semibold">Installer app</span> / <span className="font-semibold">Legg til</span>.
              </div>
            )}
          </div>
        )}

        {/* Footer link */}
        {hasHomes && (
          <div className="mt-8 text-center text-xs text-gray-500">
            Trenger du å bli med i et annet hus?{" "}
            <Link className="underline" href="/join">
              Legg inn kode
            </Link>
            .
            {anyAdmin ? "" : " Administrator kan dele link fra Del link."}
          </div>
        )}
      </div>
    </main>
  );
}