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

    const homeIds = (homes ?? [])
      .map((h) => String(h.home_id || "").trim())
      .filter(Boolean);

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
        email: string | null;
      }>
    > = {};

    let pushCountByHome: Record<string, number> = {};
    let contactsByHome: Record<
      string,
      Array<{
        phone_e164: string | null;
        sms_enabled: boolean | null;
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

      const { data: memberships, error: membersError } = await supabase
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

      const uniqueUserIds = Array.from(
        new Set(
          (memberships ?? [])
            .map((m) => String(m.user_id || "").trim())
            .filter(Boolean)
        )
      );

      const emailByUserId: Record<string, string | null> = {};

      await Promise.all(
        uniqueUserIds.map(async (userId) => {
          try {
            const { data, error: authErr } = await supabase.auth.admin.getUserById(userId);
            if (authErr) {
              emailByUserId[userId] = null;
              return;
            }
            emailByUserId[userId] = data.user?.email ?? null;
          } catch {
            emailByUserId[userId] = null;
          }
        })
      );

      for (const member of memberships ?? []) {
        const homeId = String(member.home_id || "").trim();
        const userId = String(member.user_id || "").trim();

        if (!homeId) continue;

        if (!membersByHome[homeId]) {
          membersByHome[homeId] = [];
        }

        membersByHome[homeId].push({
          user_id: userId || null,
          role: member.role ?? null,
          email: userId ? emailByUserId[userId] ?? null : null,
        });
      }

      if (uniqueUserIds.length > 0) {
        const { data: pushSubs, error: pushError } = await supabase
          .from("push_subscriptions")
          .select("user_id, home_id")
          .or(
            [
              `user_id.in.(${uniqueUserIds.join(",")})`,
              `home_id.in.(${homeIds.join(",")})`,
            ].join(",")
          );

        if (pushError) {
          return NextResponse.json({ error: pushError.message }, { status: 500 });
        }

        for (const homeId of homeIds) {
          pushCountByHome[homeId] = 0;
        }

        const memberUserIdsByHome: Record<string, Set<string>> = {};
        for (const homeId of homeIds) {
          memberUserIdsByHome[homeId] = new Set(
            (membersByHome[homeId] ?? [])
              .map((m) => String(m.user_id || "").trim())
              .filter(Boolean)
          );
        }

        for (const sub of pushSubs ?? []) {
          const subHomeId = String(sub.home_id || "").trim();
          const subUserId = String(sub.user_id || "").trim();

          if (subHomeId && pushCountByHome[subHomeId] !== undefined) {
            pushCountByHome[subHomeId] += 1;
            continue;
          }

          if (subUserId) {
            for (const homeId of homeIds) {
              if (memberUserIdsByHome[homeId]?.has(subUserId)) {
                pushCountByHome[homeId] = (pushCountByHome[homeId] ?? 0) + 1;
              }
            }
          }
        }
      }

      const { data: contacts, error: contactsError } = await supabase
        .from("contact_methods")
        .select(`
          home_id,
          phone_e164,
          sms_enabled
        `)
        .in("home_id", homeIds)
        .order("home_id");

      if (contactsError) {
        return NextResponse.json({ error: contactsError.message }, { status: 500 });
      }

      for (const row of contacts ?? []) {
        const homeId = String(row.home_id || "").trim();
        if (!homeId) continue;

        if (!contactsByHome[homeId]) {
          contactsByHome[homeId] = [];
        }

        contactsByHome[homeId].push({
          phone_e164: row.phone_e164 ?? null,
          sms_enabled: row.sms_enabled ?? null,
        });
      }
    }

    const enrichedHomes = (homes ?? []).map((home) => {
      const homeId = String(home.home_id || "").trim();
      const members = membersByHome[homeId] ?? [];
      const contacts = contactsByHome[homeId] ?? [];

      return {
        ...home,
        open_alert: openAlertsByHome[homeId] ?? null,
        members,
        members_count: members.length,
        push_devices_count: pushCountByHome[homeId] ?? 0,
        contact_methods: contacts,
        sms_contacts_count: contacts.filter((c) => c.sms_enabled === true).length,
      };
    });

    return NextResponse.json({
      ok: true,
      homes: enrichedHomes,
      count: enrichedHomes.length,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
