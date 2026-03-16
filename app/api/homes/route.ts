import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function requireBearer(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  const token = match?.[1];
  if (!token) throw new Error("Missing Authorization Bearer token");
  return token;
}

function norm(s: string) {
  return (s || "").trim().toUpperCase();
}

function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  return v == null ? null : String(v);
}

function asBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

type MembershipRow = {
  home_id: string | null;
  role: string | null;
};

type SupabaseHomeRow = {
  home_id: string;
  home_name: string | null;
  state: string | null;
  last_seen: string | null;
  last_motion: string | null;
  battery_low: boolean | null;
};

type AlertRow = {
  id: string;
  alert_id: string | null;
  home_id: string;
  type: string | null;
  alert_window: string | null;
  triggered_at: string | null;
  acknowledged: boolean | null;
  acknowledged_at: string | null;
  ack_by: string | null;
  resolved_at: string | null;
};

function isAlertOpen(alert: AlertRow) {
  if (alert.resolved_at) return false;
  if (alert.acknowledged) return false;
  if (alert.acknowledged_at) return false;
  return true;
}

export async function GET(req: Request) {
  try {
    const accessToken = requireBearer(req);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { data: memberships, error: membershipsError } = await supabase
      .from("memberships")
      .select("home_id, role");

    if (membershipsError) {
      throw new Error(membershipsError.message);
    }

    const membershipRows = (memberships ?? []) as MembershipRow[];

    const homeIds = membershipRows
      .map((m) => String(m.home_id ?? "").trim())
      .filter(Boolean);

    if (homeIds.length === 0) {
      return NextResponse.json({ homes: [] });
    }

    const { data: homesData, error: homesError } = await supabase
      .from("homes")
      .select("home_id, home_name, state, last_seen, last_motion, battery_low")
      .in("home_id", homeIds);

    if (homesError) {
      throw new Error(`Supabase homes error: ${homesError.message}`);
    }

    const { data: alertsData, error: alertsError } = await supabase
      .from("alerts")
      .select(
        "id, alert_id, home_id, type, alert_window, triggered_at, acknowledged, acknowledged_at, ack_by, resolved_at"
      )
      .in("home_id", homeIds)
      .order("triggered_at", { ascending: false });

    if (alertsError) {
      throw new Error(`Supabase alerts error: ${alertsError.message}`);
    }

    const homeMap = new Map<string, SupabaseHomeRow>();
    for (const row of (homesData ?? []) as SupabaseHomeRow[]) {
      homeMap.set(norm(row.home_id), row);
    }

    const alertsByHome = new Map<string, AlertRow[]>();
    for (const row of (alertsData ?? []) as AlertRow[]) {
      const key = norm(row.home_id);
      const existing = alertsByHome.get(key) ?? [];
      existing.push(row);
      alertsByHome.set(key, existing);
    }

    const homes = homeIds.map((hid) => {
      const membership = membershipRows.find((m) => norm(String(m.home_id ?? "")) === norm(hid));
      const homeRow = homeMap.get(norm(hid));
      const relevantAlerts = alertsByHome.get(norm(hid)) ?? [];

      const latest = relevantAlerts[0] ?? null;
      const open = relevantAlerts.find((a) => isAlertOpen(a)) ?? null;
      const lastAck =
        relevantAlerts.find((a) => !isAlertOpen(a) && Boolean(a.acknowledged || a.acknowledged_at)) ??
        null;

      const latest_open_alert = open
        ? {
            alert_id: open.id,
            type: asString(open.type),
            window: asString(open.alert_window),
            triggered_at: asString(open.triggered_at),
          }
        : null;

      const latest_alert = latest
        ? {
            alert_id: latest.id,
            type: asString(latest.type),
            window: asString(latest.alert_window),
            triggered_at: asString(latest.triggered_at),
            acknowledged: asBool(latest.acknowledged) === true,
            acknowledged_at: asString(latest.acknowledged_at),
            ack_by: asString(latest.ack_by),
          }
        : null;

      const last_checked = lastAck
        ? {
            acknowledged_at: asString(lastAck.acknowledged_at),
            ack_by: asString(lastAck.ack_by),
          }
        : null;

      return {
        home_id: hid,
        home_name: homeRow?.home_name ?? null,
        role: membership?.role ?? "viewer",

        state: homeRow?.state ?? null,
        last_seen: homeRow?.last_seen ?? null,
        last_motion: homeRow?.last_motion ?? null,
        battery_low: homeRow?.battery_low ?? null,

        latest_open_alert,
        latest_alert,
        last_checked,
      };
    });

    return NextResponse.json({ homes });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
