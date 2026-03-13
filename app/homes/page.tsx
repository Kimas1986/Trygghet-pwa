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
  last_seen: string | null;
  last_motion: string | null;
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

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
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
  const minutes = (Date.now() - d.getTime()) / 60000;
  return minutes <= 90;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} (timeout ${ms}ms)`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) throw new Error("Service worker støttes ikke");

  try {
    return await withTimeout(navigator.serviceWorker.ready, 4000, "Service worker ikke klar");
  } catch {
    try {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    } catch (e: any) {
      throw new Error(e?.message || "Kunne ikke registrere service worker");
    }

    return await withTimeout(
      navigator.serviceWorker.ready,
      8000,
      "Service worker ble ikke klar etter register"
    );
  }
}

async function hasActivePushSubscription() {
  if (typeof window === "undefined") return false;
  if (!("serviceWorker" in navigator)) return false;
  if (!("PushManager" in window)) return false;
  if (!("Notification" in window)) return false;
  if (Notification.permission !== "granted") return false;

  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return Boolean(sub);
  } catch {
    return false;
  }
}

async function ensurePushSubscription(accessToken: string) {
  if (!("PushManager" in window)) throw new Error("Push støttes ikke på denne enheten");
  if (!("Notification" in window)) throw new Error("Varsler støttes ikke på denne enheten");

  if (Notification.permission === "denied") {
    throw new Error("Varsler er blokkert. Tillat varsler i nettleser/app-innstillinger.");
  }

  const perm =
    Notification.permission === "granted"
      ? "granted"
      : await withTimeout(Notification.requestPermission(), 8000, "Varsel-tillatelse");

  if (perm !== "granted") throw new Error("Varsler ble ikke tillatt");

  const reg = await getServiceWorkerRegistration();

  const vapid = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "").trim();
  if (!vapid) throw new Error("Mangler NEXT_PUBLIC_VAPID_PUBLIC_KEY i miljøvariabler");

  const existing = await withTimeout(
    reg.pushManager.getSubscription(),
    5000,
    "Henter eksisterende subscription"
  );

  const sub =
    existing ??
    (await withTimeout(
      reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      }),
      12000,
      "Oppretter push subscription"
    ));

  const res = await withTimeout(
    fetch("/api/push/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(sub),
    }),
    12000,
    "Lagrer subscription på server"
  );

  const text = await res.text();
  let j: any = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = {};
  }

  if (!res.ok) throw new Error(j?.error || `Subscribe feilet (${res.status})`);
}

export default function HomesPage() {
  const router = useRouter();

  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [homesLoading, setHomesLoading] = useState(false);
  const [homes, setHomes] = useState<HomeRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [inviteBusy, setInviteBusy] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteOpenFor, setInviteOpenFor] = useState<string | null>(null);
  const [inviteByHome, setInviteByHome] = useState<Record<string, string>>({});

  const [ackBusy, setAckBusy] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);

  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushReady, setPushReady] = useState(false);

  const [renameBusy, setRenameBusy] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameOpenFor, setRenameOpenFor] = useState<string | null>(null);
  const [renameValueByHome, setRenameValueByHome] = useState<Record<string, string>>({});

  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isSystemAdmin, setIsSystemAdmin] = useState(false);

  const [origin, setOrigin] = useState<string>("");

  const didLoad = useRef(false);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handler);

    hasActivePushSubscription().then((active) => {
      setPushReady(active);
    });

    return () => window.removeEventListener("beforeinstallprompt", handler);
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

      const { data: adminRow } = await supabase
        .from("system_admins")
        .select("user_id")
        .eq("user_id", s.user.id)
        .maybeSingle();

      if (alive) {
        setIsSystemAdmin(Boolean(adminRow));
      }

      setLoading(false);
    }

    init();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (!newSession) {
        setIsSystemAdmin(false);
        router.replace("/login");
      }
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [router]);

  async function loadHomes() {
    setError(null);
    setHomesLoading(true);

    try {
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
    } finally {
      setHomesLoading(false);
    }
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

  async function onLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  async function onEnablePush() {
    setPushError(null);
    setPushBusy(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return router.replace("/login");

      await ensurePushSubscription(token);
      setPushReady(true);
      alert("Push-varsler aktivert ✅");
    } catch (e: any) {
      const msg = e?.message ?? "Klarte ikke aktivere push-varsler";
      setPushError(msg);
      alert(msg);
    } finally {
      setPushBusy(false);
    }
  }

  async function installApp() {
    if (!installPrompt) return;

    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;

    if (choice.outcome === "accepted") {
      setInstallPrompt(null);
    }
  }

  function joinUrl(code: string) {
    const base = origin || "";
    return `${base}/join?code=${encodeURIComponent(code)}`;
  }

  function openRename(home: HomeRow) {
    const currentName = (home.home_name || "").trim() || home.home_id;
    setRenameError(null);
    setRenameOpenFor(home.home_id);
    setRenameValueByHome((prev) => ({
      ...prev,
      [home.home_id]: currentName,
    }));
  }

  async function saveRename(home_id: string) {
    setRenameError(null);
    setRenameBusy(home_id);

    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;

      if (!token) {
        setRenameError("Du er ikke innlogget. Logg inn på nytt.");
        router.replace("/login");
        return;
      }

      const name = String(renameValueByHome[home_id] ?? "").trim();

      const res = await fetch(`/api/homes/${encodeURIComponent(home_id)}/rename`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name }),
      });

      const j = await res.json().catch(() => ({}));

      if (!res.ok) {
        setRenameError(j?.error || `Rename feilet (${res.status})`);
        return;
      }

      setHomes((prev) =>
        prev.map((h) =>
          h.home_id === home_id
            ? {
                ...h,
                home_name: name,
              }
            : h
        )
      );

      setRenameOpenFor(null);
    } finally {
      setRenameBusy(null);
    }
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

  if (loading || homesLoading) {
    return (
      <main className="min-h-screen bg-gray-50 p-4">
        <div className="mx-auto max-w-2xl rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          Laster…
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50 pb-32">
      <div className="sticky top-0 z-10 border-b border-gray-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-gray-900">Trygghet</div>
            <div className="text-xs text-gray-600">Status for hus du følger</div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isSystemAdmin && (
              <Link
                href="/system"
                className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm hover:bg-gray-50"
              >
                System
              </Link>
            )}

            {!pushReady && (
              <button
                type="button"
                onClick={onEnablePush}
                disabled={pushBusy}
                className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm hover:bg-gray-50 disabled:opacity-60"
              >
                {pushBusy ? "Aktiverer…" : "Aktiver push-varsler"}
              </button>
            )}

            <button
              type="button"
              onClick={onLogout}
              className="rounded-xl bg-gray-900 px-3 py-2 text-sm text-white shadow-sm hover:bg-gray-800"
            >
              Logg ut
            </button>
          </div>
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

        {pushError && (
          <div className="mx-auto max-w-2xl px-4 pb-3">
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {pushError}
            </div>
          </div>
        )}

        {renameError && (
          <div className="mx-auto max-w-2xl px-4 pb-3">
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {renameError}
            </div>
          </div>
        )}
      </div>

      <div className="mx-auto max-w-2xl p-4">
        {!hasHomes && (
          <div className="mb-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-gray-900">Ingen hus tilgjengelig</h2>
            <p className="mt-1 text-sm text-gray-600">
              Du er innlogget, men er ikke koblet til et hus ennå.
            </p>
          </div>
        )}

        {homes.map((h) => {
          const stateLower = (h.state || "").toLowerCase();
          const isRedCard = stateLower === "red";
          const meta = stateMeta(h.state);

          const isAdmin = (h.role || "").toLowerCase() === "admin";
          const isInviteOpen = inviteOpenFor === h.home_id;
          const isRenameOpen = renameOpenFor === h.home_id;
          const code = inviteByHome[h.home_id] || "";
          const link = code ? joinUrl(code) : "";

          const motionAgo = timeAgo(h.last_motion);
          const title = (h.home_name || "").trim() || h.home_id;
          const online = isSystemOnline(h.last_seen);

          const latestAlert = h.latest_alert ?? null;
          const canAck = Boolean(latestAlert?.alert_id);
          const isAcked = Boolean(latestAlert?.acknowledged);

          const alertStartedAt =
            latestAlert?.triggered_at ??
            h.latest_open_alert?.triggered_at ??
            null;

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

                      <div className={`mt-1 text-xs ${meta.sub}`}>
                        ID: <span className="font-mono">{h.home_id}</span>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                      <Link
                        href={`/homes/${encodeURIComponent(h.home_id)}`}
                        className="rounded-xl border border-gray-200 bg-white/80 px-3 py-2 text-sm text-gray-900 shadow-sm hover:bg-white"
                      >
                        Vis historikk
                      </Link>

                      {isAdmin && (
                        <button
                          type="button"
                          onClick={() => openRename(h)}
                          className="rounded-xl border border-gray-200 bg-white/80 px-3 py-2 text-sm text-gray-900 shadow-sm hover:bg-white"
                        >
                          Endre navn
                        </button>
                      )}

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

                  {isAdmin && isRenameOpen && (
                    <div className="mt-4 rounded-2xl border border-gray-200 bg-white/85 p-4 ring-1 ring-black/5">
                      <div className="text-sm font-semibold text-gray-900">Endre navn på hus</div>

                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <input
                          type="text"
                          value={renameValueByHome[h.home_id] ?? ""}
                          onChange={(e) =>
                            setRenameValueByHome((prev) => ({
                              ...prev,
                              [h.home_id]: e.target.value,
                            }))
                          }
                          placeholder="Skriv nytt navn"
                          className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
                        />

                        <button
                          type="button"
                          onClick={() => saveRename(h.home_id)}
                          disabled={renameBusy === h.home_id}
                          className="rounded-xl bg-gray-900 px-4 py-2 text-sm text-white shadow-sm hover:bg-gray-800 disabled:opacity-60"
                        >
                          {renameBusy === h.home_id ? "Lagrer…" : "Lagre"}
                        </button>

                        <button
                          type="button"
                          onClick={() => setRenameOpenFor(null)}
                          className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm text-gray-900 shadow-sm hover:bg-gray-50"
                        >
                          Avbryt
                        </button>
                      </div>
                    </div>
                  )}

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
                          {ackBusy === latestAlert?.alert_id
                            ? "Logger…"
                            : isAcked
                            ? "Sjekket!"
                            : "Jeg sjekker"}
                        </button>
                      </div>
                    </div>
                  )}

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

                  {isAdmin && isInviteOpen && (
                    <div className="mt-4 rounded-2xl border border-gray-200 bg-white/80 p-4 ring-1 ring-black/5">
                      <div className="text-sm text-gray-700">
                        Send linken til pårørende. Koden blir forhåndsutfylt.
                      </div>

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
      </div>

      <div className="fixed bottom-4 left-0 right-0 z-20 flex flex-col items-center gap-2 px-4">
        {!pushReady && (
          <button
            type="button"
            onClick={onEnablePush}
            disabled={pushBusy}
            className="rounded-2xl border border-gray-200 bg-white px-5 py-3 text-sm font-semibold text-gray-900 shadow-lg hover:bg-gray-50 disabled:opacity-60"
          >
            {pushBusy ? "Aktiverer…" : "🔔 Aktiver push-varsler"}
          </button>
        )}

        {installPrompt && (
          <button
            type="button"
            onClick={installApp}
            className="rounded-2xl bg-gray-900 px-5 py-3 text-sm font-semibold text-white shadow-lg hover:bg-gray-800"
          >
            📲 Installer Trygghet
          </button>
        )}
      </div>
    </main>
  );
}