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

function asBool(v: unknown): boolean {
  return v === true || v === "true";
}

type MembershipRow = {
  home_id: string | null;
  role: string | null;
};

type HomeRow = {
  home_id: string;
  home_name: string | null;
  state: string | null;
  last_seen: string | null;
  last_motion: string | null;
  battery_low: boolean | null;
  last_alert_window: string | null;
  last_alert_time: string | null;
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

async function ensureMembership(accessToken: string, homeId: string) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const { data, error } = await supabase.from("memberships").select("home_id, role");
  if (error) throw new Error(error.message);

  const wanted = norm(homeId);
  const rows = (data ?? []) as MembershipRow[];
  const match = rows.find((m) => norm(String(m.home_id ?? "")) === wanted);
  return match ?? null;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ homeId: string }> }
) {
  try {
    const accessToken = requireBearer(req);

    const { homeId: rawHomeId } = await ctx.params;
    const homeId = decodeURIComponent(String(rawHomeId ?? "")).trim();

    if (!homeId) {
      return NextResponse.json({ error: "Missing homeId" }, { status: 400 });
    }

    const membership = await ensureMembership(accessToken, homeId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { data: homeData, error: homeError } = await supabase
      .from("homes")
      .select(
        "home_id, home_name, state, last_seen, last_motion, battery_low, last_alert_window, last_alert_time"
      )
      .eq("home_id", homeId)
      .maybeSingle();

    if (homeError) {
      throw new Error(homeError.message);
    }

    const homeRow = (homeData as HomeRow | null) ?? null;

    const home = {
      home_id: homeId,
      home_name: homeRow?.home_name ?? null,
      role: membership.role ?? "viewer",
      state: asString(homeRow?.state),
      last_seen: asString(homeRow?.last_seen),
      last_motion: asString(homeRow?.last_motion),
      battery_low: homeRow?.battery_low ?? false,
      last_alert_window: asString(homeRow?.last_alert_window),
      last_alert_time: asString(homeRow?.last_alert_time),
    };

    const { data: alertsData, error: alertsError } = await supabase
      .from("alerts")
      .select(
        "id, alert_id, home_id, type, alert_window, triggered_at, acknowledged, acknowledged_at, ack_by, resolved_at"
      )
      .eq("home_id", homeId)
      .order("triggered_at", { ascending: false });

    if (alertsError) {
      throw new Error(alertsError.message);
    }

    const alerts = ((alertsData ?? []) as AlertRow[]).map((a) => {
      const acknowledged = asBool(a.acknowledged) || Boolean(a.acknowledged_at);

      return {
        alert_id: a.id,
        home_id: homeId,
        type: asString(a.type),
        window: asString(a.alert_window),
        triggered_at: asString(a.triggered_at),
        acknowledged,
        acknowledged_at: asString(a.acknowledged_at),
        ack_by: asString(a.ack_by),
        resolved_at: asString(a.resolved_at),
      };
    });

    return NextResponse.json({ home, alerts });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}