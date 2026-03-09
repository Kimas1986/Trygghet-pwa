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

type MembershipRow = {
  home_id: string | null;
  role: string | null;
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
  escalation_sent: boolean | null;
};

async function ensureMembership(accessToken: string, homeId: string) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const { data, error } = await supabase.from("memberships").select("home_id, role");

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as MembershipRow[];
  const wanted = norm(homeId);
  const match = rows.find((m) => norm(String(m.home_id ?? "")) === wanted);
  return match ?? null;
}

type Ctx = {
  params: Promise<{ alertId: string }>;
};

export async function POST(req: Request, ctx: Ctx) {
  try {
    const accessToken = requireBearer(req);

    const { alertId: rawAlertId } = await ctx.params;
    const alertIdParam = decodeURIComponent(String(rawAlertId || "")).trim();

    if (!alertIdParam) {
      return NextResponse.json({ error: "Missing alertId" }, { status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    let alertRow: AlertRow | null = null;

    const { data: byId, error: byIdError } = await supabase
      .from("alerts")
      .select(
        "id, alert_id, home_id, type, alert_window, triggered_at, acknowledged, acknowledged_at, ack_by, resolved_at, escalation_sent"
      )
      .eq("id", alertIdParam)
      .maybeSingle();

    if (byIdError) {
      throw new Error(byIdError.message);
    }

    if (byId) {
      alertRow = byId as AlertRow;
    } else {
      const { data: byAlertId, error: byAlertIdError } = await supabase
        .from("alerts")
        .select(
          "id, alert_id, home_id, type, alert_window, triggered_at, acknowledged, acknowledged_at, ack_by, resolved_at, escalation_sent"
        )
        .eq("alert_id", alertIdParam)
        .maybeSingle();

      if (byAlertIdError) {
        throw new Error(byAlertIdError.message);
      }

      alertRow = (byAlertId as AlertRow | null) ?? null;
    }

    if (!alertRow) {
      return NextResponse.json({ error: "Alert ikke funnet" }, { status: 404 });
    }

    const membership = await ensureMembership(accessToken, alertRow.home_id);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (alertRow.acknowledged) {
      return NextResponse.json({ ok: true, already: true });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) {
      throw new Error(userError.message);
    }

    const email = userData?.user?.email ?? "unknown";
    const nowIso = new Date().toISOString();

    const { error: updateError } = await supabase
      .from("alerts")
      .update({
        acknowledged: true,
        acknowledged_at: nowIso,
        ack_by: email,
      })
      .eq("id", alertRow.id);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}