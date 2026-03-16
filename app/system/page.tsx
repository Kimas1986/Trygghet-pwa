"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

type OpenAlert = {
  id: string | null;
  alert_id: string | null;
  type: string | null;
  alert_window: string | null;
  triggered_at: string | null;
  acknowledged: boolean | null;
  acknowledged_at: string | null;
  ack_by: string | null;
  resolved_at: string | null;
  escalation_sent: boolean | null;
} | null;

type Member = {
  user_id: string | null;
  role: string | null;
  email: string | null;
};

type ContactMethod = {
  phone_e164: string | null;
  sms_enabled: boolean | null;
};

type Home = {
  home_id: string;
  home_name: string | null;
  state: string | null;
  mode: string | null;
  last_seen: string | null;
  last_motion: string | null;
  last_door_at: string | null;
  pending_away_since: string | null;
  battery_low: boolean | null;
  system_ok: boolean | null;
  open_alert: OpenAlert;
  members: Member[];
  members_count: number;
  push_devices_count: number;
  contact_methods: ContactMethod[];
  sms_contacts_count: number;
};

type FilterKey =
  | "all"
  | "red"
  | "grey"
  | "green"
  | "away"
  | "offline"
  | "battery_low"
  | "system_fail"
  | "open_alert";

function isOffline(lastSeen: string | null) {
  if (!lastSeen) return true;
  const d = new Date(lastSeen);
  if (Number.isNaN(d.getTime())) return true;
  const minutes = (Date.now() - d.getTime()) / 60000;
  return minutes > 90;
}

function formatDateTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function shortUserId(userId: string | null) {
  if (!userId) return "—";
  if (userId.length <= 12) return userId;
  return `${userId.slice(0, 8)}…${userId.slice(-4)}`;
}

export default function SystemPage() {
  const router = useRouter();

  const [homes, setHomes] = useState<Home[]>([]);
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");

  async function load() {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (!token) {
      router.replace("/login");
      return;
    }

    const res = await fetch("/api/system/homes", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const j = await res.json().catch(() => ({}));

    if (res.status === 403) {
      router.replace("/homes");
      return;
    }

    if (res.status === 401) {
      router.replace("/login");
      return;
    }

    if (j.homes) {
      setHomes(j.homes);
      setAllowed(true);
    }

    setLoading(false);
  }

  async function testPush(home_id: string) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (!token) {
      router.replace("/login");
      return;
    }

    const res = await fetch("/api/system/test-push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        home_id,
      }),
    });

    const j = await res.json().catch(() => ({}));

    if (!res.ok) {
      alert(j?.error || "Test push feilet");
      return;
    }

    alert(`Push sendt til ${home_id} (${j.sent} enheter)`);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = useMemo(() => {
    const total = homes.length;
    const red = homes.filter((h) => (h.state || "").toLowerCase() === "red").length;
    const grey = homes.filter((h) => (h.state || "").toLowerCase() === "grey").length;
    const green = homes.filter((h) => (h.state || "").toLowerCase() === "green").length;
    const away = homes.filter((h) => (h.mode || "").toLowerCase() === "away").length;
    const offline = homes.filter((h) => isOffline(h.last_seen)).length;
    const batteryLow = homes.filter((h) => h.battery_low === true).length;
    const systemFail = homes.filter((h) => h.system_ok === false).length;
    const openAlerts = homes.filter((h) => !!h.open_alert).length;

    return {
      total,
      red,
      grey,
      green,
      away,
      offline,
      batteryLow,
      systemFail,
      openAlerts,
    };
  }, [homes]);

  const filteredHomes = useMemo(() => {
    const q = query.trim().toLowerCase();

    return homes.filter((h) => {
      const name = (h.home_name || "").toLowerCase();
      const id = (h.home_id || "").toLowerCase();
      const state = (h.state || "").toLowerCase();
      const mode = (h.mode || "").toLowerCase();
      const offline = isOffline(h.last_seen);
      const batteryLow = h.battery_low === true;
      const systemFail = h.system_ok === false;
      const hasOpenAlert = !!h.open_alert;

      const memberMatch = (h.members || []).some((m) => {
        const email = (m.email || "").toLowerCase();
        const uid = (m.user_id || "").toLowerCase();
        const role = (m.role || "").toLowerCase();
        return email.includes(q) || uid.includes(q) || role.includes(q);
      });

      const contactMatch = (h.contact_methods || []).some((c) => {
        const phone = (c.phone_e164 || "").toLowerCase();
        const sms = c.sms_enabled === true ? "sms på" : "sms av";
        return phone.includes(q) || sms.includes(q);
      });

      const matchesQuery =
        !q || name.includes(q) || id.includes(q) || memberMatch || contactMatch;

      let matchesFilter = true;

      if (filter === "red") matchesFilter = state === "red";
      if (filter === "grey") matchesFilter = state === "grey";
      if (filter === "green") matchesFilter = state === "green";
      if (filter === "away") matchesFilter = mode === "away";
      if (filter === "offline") matchesFilter = offline;
      if (filter === "battery_low") matchesFilter = batteryLow;
      if (filter === "system_fail") matchesFilter = systemFail;
      if (filter === "open_alert") matchesFilter = hasOpenAlert;

      return matchesQuery && matchesFilter;
    });
  }, [homes, query, filter]);

  if (loading) {
    return (
      <main className="p-6">
        <div className="mx-auto max-w-6xl">Laster systemstatus…</div>
      </main>
    );
  }

  if (!allowed) {
    return null;
  }

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Systemoversikt</h1>
            <div className="text-sm text-gray-600">Intern driftsside for alle hus</div>
          </div>

          <button
            type="button"
            onClick={() => load()}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm hover:bg-gray-50"
          >
            Oppdater nå
          </button>
        </div>

        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5 xl:grid-cols-9">
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={`rounded-2xl border p-4 text-left shadow-sm ${
              filter === "all" ? "border-gray-900 bg-gray-900 text-white" : "bg-white"
            }`}
          >
            <div className={`text-xs ${filter === "all" ? "text-gray-200" : "text-gray-500"}`}>
              Totalt
            </div>
            <div className="mt-1 text-2xl font-semibold">{stats.total}</div>
          </button>

          <button
            type="button"
            onClick={() => setFilter("open_alert")}
            className={`rounded-2xl border p-4 text-left shadow-sm ${
              filter === "open_alert"
                ? "border-red-950 bg-red-950 text-white"
                : "border-red-300 bg-red-100"
            }`}
          >
            <div
              className={`text-xs ${filter === "open_alert" ? "text-red-100" : "text-red-800"}`}
            >
              Åpne alerts
            </div>
            <div className="mt-1 text-2xl font-semibold">{stats.openAlerts}</div>
          </button>

          <button
            type="button"
            onClick={() => setFilter("red")}
            className={`rounded-2xl border p-4 text-left shadow-sm ${
              filter === "red" ? "border-red-900 bg-red-900 text-white" : "border-red-200 bg-red-50"
            }`}
          >
            <div className={`text-xs ${filter === "red" ? "text-red-100" : "text-red-700"}`}>
              Røde
            </div>
            <div className="mt-1 text-2xl font-semibold">{stats.red}</div>
          </button>

          <button
            type="button"
            onClick={() => setFilter("grey")}
            className={`rounded-2xl border p-4 text-left shadow-sm ${
              filter === "grey" ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 bg-white"
            }`}
          >
            <div className={`text-xs ${filter === "grey" ? "text-gray-200" : "text-gray-500"}`}>
              Grå
            </div>
            <div className="mt-1 text-2xl font-semibold">{stats.grey}</div>
          </button>

          <button
            type="button"
            onClick={() => setFilter("green")}
            className={`rounded-2xl border p-4 text-left shadow-sm ${
              filter === "green"
                ? "border-green-900 bg-green-900 text-white"
                : "border-green-200 bg-green-50"
            }`}
          >
            <div className={`text-xs ${filter === "green" ? "text-green-100" : "text-green-700"}`}>
              Grønne
            </div>
            <div className="mt-1 text-2xl font-semibold">{stats.green}</div>
          </button>

          <button
            type="button"
            onClick={() => setFilter("away")}
            className={`rounded-2xl border p-4 text-left shadow-sm ${
              filter === "away"
                ? "border-amber-900 bg-amber-900 text-white"
                : "border-amber-200 bg-amber-50"
            }`}
          >
            <div className={`text-xs ${filter === "away" ? "text-amber-100" : "text-amber-700"}`}>
              Away
            </div>
            <div className="mt-1 text-2xl font-semibold">{stats.away}</div>
          </button>

          <button
            type="button"
            onClick={() => setFilter("offline")}
            className={`rounded-2xl border p-4 text-left shadow-sm ${
              filter === "offline"
                ? "border-gray-800 bg-gray-800 text-white"
                : "border-gray-300 bg-gray-100"
            }`}
          >
            <div className={`text-xs ${filter === "offline" ? "text-gray-200" : "text-gray-700"}`}>
              Offline
            </div>
            <div className="mt-1 text-2xl font-semibold">{stats.offline}</div>
          </button>

          <button
            type="button"
            onClick={() => setFilter("battery_low")}
            className={`rounded-2xl border p-4 text-left shadow-sm ${
              filter === "battery_low"
                ? "border-yellow-800 bg-yellow-800 text-white"
                : "border-yellow-200 bg-yellow-50"
            }`}
          >
            <div
              className={`text-xs ${filter === "battery_low" ? "text-yellow-100" : "text-yellow-700"}`}
            >
              Lavt batteri
            </div>
            <div className="mt-1 text-2xl font-semibold">{stats.batteryLow}</div>
          </button>

          <button
            type="button"
            onClick={() => setFilter("system_fail")}
            className={`rounded-2xl border p-4 text-left shadow-sm ${
              filter === "system_fail"
                ? "border-orange-900 bg-orange-900 text-white"
                : "border-orange-200 bg-orange-50"
            }`}
          >
            <div
              className={`text-xs ${filter === "system_fail" ? "text-orange-100" : "text-orange-700"}`}
            >
              Systemfeil
            </div>
            <div className="mt-1 text-2xl font-semibold">{stats.systemFail}</div>
          </button>
        </div>

        <div className="mb-4 rounded-2xl border bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Søk på husnavn, home_id, e-post, rolle, user_id eller telefon"
              className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            />

            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as FilterKey)}
              className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-500"
            >
              <option value="all">Alle</option>
              <option value="open_alert">Åpne alerts</option>
              <option value="red">Røde</option>
              <option value="grey">Grå</option>
              <option value="green">Grønne</option>
              <option value="away">Away</option>
              <option value="offline">Offline</option>
              <option value="battery_low">Lavt batteri</option>
              <option value="system_fail">Systemfeil</option>
            </select>
          </div>

          <div className="mt-3 text-sm text-gray-600">
            Viser {filteredHomes.length} av {homes.length} hus
          </div>
        </div>

        <div className="grid gap-3">
          {filteredHomes.map((h) => (
            <div key={h.home_id} className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="font-semibold text-gray-900">{h.home_name || h.home_id}</div>
                  <div className="text-sm text-gray-600">{h.home_id}</div>
                </div>

                <div className="flex flex-col gap-2 sm:items-end">
                  <button
                    type="button"
                    onClick={() => testPush(h.home_id)}
                    className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-xs text-gray-900 hover:bg-gray-50"
                  >
                    Test push
                  </button>

                  {h.open_alert && (
                    <div className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
                      <div className="font-semibold">Åpen alert</div>
                      <div>Type: {h.open_alert.type || "—"}</div>
                      <div>Startet: {formatDateTime(h.open_alert.triggered_at)}</div>
                      <div>Ack: {h.open_alert.acknowledged ? "Ja" : "Nei"}</div>
                      <div>SMS sendt: {h.open_alert.escalation_sent ? "Ja" : "Nei"}</div>
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
                <div>
                  <b>state</b>
                  <br />
                  {h.state || "—"}
                </div>

                <div>
                  <b>mode</b>
                  <br />
                  {h.mode || "—"}
                </div>

                <div>
                  <b>last motion</b>
                  <br />
                  {h.last_motion || "—"}
                </div>

                <div>
                  <b>last seen</b>
                  <br />
                  {h.last_seen || "—"}
                </div>

                <div>
                  <b>door</b>
                  <br />
                  {h.last_door_at || "—"}
                </div>

                <div>
                  <b>pending away</b>
                  <br />
                  {h.pending_away_since || "—"}
                </div>

                <div>
                  <b>battery</b>
                  <br />
                  {h.battery_low ? "LOW" : "OK"}
                </div>

                <div>
                  <b>system</b>
                  <br />
                  {h.system_ok ? "OK" : "FAIL"}
                </div>
              </div>

              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-gray-900">Medlemmer</div>
                    <div className="text-xs text-gray-600">
                      Antall: {h.members_count ?? h.members?.length ?? 0}
                    </div>
                  </div>

                  {h.members && h.members.length > 0 ? (
                    <div className="grid gap-2">
                      {h.members.map((m, idx) => (
                        <div
                          key={`${h.home_id}-${m.user_id ?? "unknown"}-${idx}`}
                          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate font-medium text-gray-900">
                                {m.email || "Ukjent e-post"}
                              </div>
                              <div className="font-mono text-xs text-gray-500">
                                {shortUserId(m.user_id)}
                              </div>
                            </div>

                            <div
                              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                                (m.role || "").toLowerCase() === "admin"
                                  ? "bg-gray-900 text-white"
                                  : "bg-gray-200 text-gray-800"
                              }`}
                            >
                              {m.role || "—"}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-gray-500">Ingen medlemmer funnet</div>
                  )}
                </div>

                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-gray-900">Varslingsmottakere</div>
                    <div className="text-xs text-gray-600">
                      Push: {h.push_devices_count ?? 0} · SMS: {h.sms_contacts_count ?? 0}
                    </div>
                  </div>

                  <div className="mb-3 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm">
                    <div>
                      <b>Push-enheter</b>
                    </div>
                    <div className="mt-1 text-gray-700">{h.push_devices_count ?? 0}</div>
                  </div>

                  {h.contact_methods && h.contact_methods.length > 0 ? (
                    <div className="grid gap-2">
                      {h.contact_methods.map((c, idx) => (
                        <div
                          key={`${h.home_id}-contact-${c.phone_e164 ?? "unknown"}-${idx}`}
                          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="font-mono text-gray-800">{c.phone_e164 || "Ukjent nummer"}</div>
                            <div
                              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                                c.sms_enabled === true
                                  ? "bg-green-600 text-white"
                                  : "bg-gray-200 text-gray-800"
                              }`}
                            >
                              {c.sms_enabled === true ? "SMS på" : "SMS av"}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-gray-500">Ingen SMS-kontakter funnet</div>
                  )}
                </div>
              </div>
            </div>
          ))}

          {filteredHomes.length === 0 && (
            <div className="rounded-2xl border bg-white p-6 text-sm text-gray-600 shadow-sm">
              Ingen hus matcher søket eller filteret.
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
