"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import type { Session } from "@supabase/supabase-js";

type HomeDetail = {
  home_id: string;
  home_name?: string | null;
  role: string;
};

type AlertRow = {
  alert_id: string;
  home_id: string;
  type: string | null;
  window: string | null;
  triggered_at: string | null;
  acknowledged: boolean;
  acknowledged_at: string | null;
  ack_by: string | null;
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

function translateType(type: string | null) {
  if (!type) return "Hendelse";

  if (type === "red_inactivity") {
    return "Ingen bevegelse registrert";
  }

  return type;
}

function prettifyNameOrEmail(v: string | null) {
  if (!v) return null;
  const s = v.trim();
  if (!s) return null;

  const at = s.indexOf("@");
  const base = at > 0 ? s.slice(0, at) : s;

  const cleaned = base
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return s;

  return cleaned
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

async function readJsonSafe(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export default function HomePage() {
  const router = useRouter();
  const params = useParams<{ homeId?: string }>();

  const raw = params?.homeId;
  const homeId = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";

  const [session, setSession] = useState<Session | null>(null);
  const [home, setHome] = useState<HomeDetail | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);

  const historyAlerts = useMemo(() => {
    return alerts
      .filter((a) => a.type === "red_inactivity")
      .slice(0, 30);
  }, [alerts]);

  const loadData = async (homeIdValue: string) => {
    const { data: sessionData } = await supabase.auth.getSession();
    const currentSession = sessionData.session;

    if (!currentSession) {
      router.replace("/login");
      return;
    }

    setSession(currentSession);

    const res = await fetch(`/api/homes/${encodeURIComponent(homeIdValue)}`, {
      headers: { Authorization: `Bearer ${currentSession.access_token}` },
    });

    const json = await readJsonSafe(res);

    if (!res.ok) {
      alert("API error");
      setLoading(false);
      return;
    }

    setHome(json.home ?? null);
    setAlerts(json.alerts ?? []);
    setLoading(false);
  };

  useEffect(() => {
    const run = async () => {
      if (!homeId) {
        setLoading(false);
        return;
      }

      setLoading(true);
      await loadData(homeId);
    };

    run();
  }, [homeId]);

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 p-4">
        <div className="mx-auto max-w-3xl rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          Laster…
        </div>
      </main>
    );
  }

  const title = (home?.home_name || "").trim() || homeId;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <div className="mb-4">
          <Link
            href="/homes"
            className="inline-flex items-center rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50"
          >
            ← Tilbake
          </Link>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">{title}</h1>

          <div className="mt-2 text-sm text-gray-600">
            ID: <span className="font-mono">{homeId}</span>
          </div>

          <p className="mt-1 break-all text-sm text-gray-600">
            Innlogget som: {session?.user.email}
          </p>
        </div>

        <div className="mt-6 rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-200 p-4 font-semibold text-gray-900">Historikk</div>

          {historyAlerts.length === 0 ? (
            <div className="p-4 text-sm text-gray-600">Ingen hendelser ennå.</div>
          ) : (
            <ul className="divide-y divide-gray-200">
              {historyAlerts.map((a) => {
                const titleText = translateType(a.type);

                if (a.acknowledged) {
                  const when = a.acknowledged_at;
                  const ago = timeAgo(when);
                  const who = prettifyNameOrEmail(a.ack_by);

                  const line = [
                    "Sjekket",
                    who ? `av ${who}` : null,
                    ago ? `– ${ago}` : when ? `– ${formatDate(when)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" ");

                  return (
                    <li key={a.alert_id} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-semibold text-gray-900">{titleText}</div>
                          <div className="mt-2 text-sm text-gray-700">{line}</div>
                        </div>

                        <div className="shrink-0 rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-900">
                          Sjekket
                        </div>
                      </div>
                    </li>
                  );
                }

                const started = a.triggered_at;
                const startedAgo = timeAgo(started);

                return (
                  <li key={a.alert_id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-gray-900">{titleText}</div>
                        <div className="mt-2 text-sm text-gray-700">
                          Ikke sjekket
                          {startedAgo
                            ? ` – startet ${startedAgo}`
                            : started
                            ? ` – startet ${formatDate(started)}`
                            : ""}
                        </div>
                      </div>

                      <div className="shrink-0 rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">
                        Ikke sjekket
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="border-t border-gray-200 p-4 text-xs text-gray-500">
            Viser siste 30 røde hendelser.
          </div>
        </div>
      </div>
    </main>
  );
}