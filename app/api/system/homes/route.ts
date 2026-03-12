import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });
}

export async function GET(req: Request) {
  try {
    const auth = req.headers.get("authorization") || "";
    const token = auth.replace("Bearer ", "");

    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 401 });
    }

    const supabase = adminClient();

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser(token);

    if (userErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: adminRow } = await supabase
      .from("system_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!adminRow) {
      return NextResponse.json({ error: "Not system admin" }, { status: 403 });
    }

    const { data: homes, error } = await supabase
      .from("homes")
      .select(`
        home_id,
        home_name,
        state,
        mode,
        last_seen,
        last_motion,
        last_door_at,
        pending_away_since,
        battery_low,
        system_ok,
        last_alert_window,
        last_alert_time
      `)
      .order("home_id");

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const homeIds = (homes ?? []).map((h) => String(h.home_id || "").trim()).filter(Boolean);

    let openAlertsByHome: Record<
      string,
      {
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
      }
    > = {};

    let membersByHome: Record<
      string,
      Array<{
        user_id: string | null;
        role: string | null;
      }>
    > = {};

    if (homeIds.length > 0) {
      const { data: openAlerts, error: alertsError } = await supabase
        .from("alerts")
        .select(`
          id,
          alert_id,
          home_id,
          type,
          alert_window,
          triggered_at,
          acknowledged,
          acknowledged_at,
          ack_by,
          resolved_at,
          escalation_sent
        `)
        .in("home_id", homeIds)
        .is("resolved_at", null)
        .order("triggered_at", { ascending: false });

      if (alertsError) {
        return NextResponse.json({ error: alertsError.message }, { status: 500 });
      }

      for (const alert of openAlerts ?? []) {
        const homeId = String(alert.home_id || "").trim();
        if (!homeId) continue;

        if (!openAlertsByHome[homeId]) {
          openAlertsByHome[homeId] = {
            id: alert.id ?? null,
            alert_id: alert.alert_id ?? null,
            type: alert.type ?? null,
            alert_window: alert.alert_window ?? null,
            triggered_at: alert.triggered_at ?? null,
            acknowledged: alert.acknowledged ?? null,
            acknowledged_at: alert.acknowledged_at ?? null,
            ack_by: alert.ack_by ?? null,
            resolved_at: alert.resolved_at ?? null,
            escalation_sent: alert.escalation_sent ?? null,
          };
        }
      }

      const { data: members, error: membersError } = await supabase
        .from("memberships")
        .select(`
          home_id,
          user_id,
          role
        `)
        .in("home_id", homeIds)
        .order("home_id")
        .order("role");

      if (membersError) {
        return NextResponse.json({ error: membersError.message }, { status: 500 });
      }

      for (const member of members ?? []) {
        const homeId = String(member.home_id || "").trim();
        if (!homeId) continue;

        if (!membersByHome[homeId]) {
          membersByHome[homeId] = [];
        }

        membersByHome[homeId].push({
          user_id: member.user_id ?? null,
          role: member.role ?? null,
        });
      }
    }

    const enrichedHomes = (homes ?? []).map((home) => ({
      ...home,
      open_alert: openAlertsByHome[String(home.home_id || "").trim()] ?? null,
      members: membersByHome[String(home.home_id || "").trim()] ?? [],
      members_count: (membersByHome[String(home.home_id || "").trim()] ?? []).length,
    }));

    return NextResponse.json({
      ok: true,
      homes: enrichedHomes,
      count: enrichedHomes.length,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}