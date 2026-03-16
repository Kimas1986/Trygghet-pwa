import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY!;

webpush.setVapidDetails(
  "mailto:admin@trygghet.app",
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });
}

export async function POST(req: Request) {
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

    const body = await req.json().catch(() => ({}));
    const home_id = String(body.home_id || "").trim();

    if (!home_id) {
      return NextResponse.json({ error: "Missing home_id" }, { status: 400 });
    }

    const { data: memberships } = await supabase
      .from("memberships")
      .select("user_id")
      .eq("home_id", home_id);

    const userIds =
      memberships?.map((m) => String(m.user_id || "").trim()).filter(Boolean) ||
      [];

    if (userIds.length === 0) {
      return NextResponse.json({ ok: true, sent: 0 });
    }

    const { data: subs } = await supabase
      .from("push_subscriptions")
      .select("subscription")
      .in("user_id", userIds);

    let sent = 0;

    for (const row of subs || []) {
      try {
        await webpush.sendNotification(
          row.subscription,
          JSON.stringify({
            title: "Testvarsel",
            body: `Push fungerer for ${home_id}`,
            url: "/homes",
          })
        );

        sent++;
      } catch (err) {
        console.error("Push error", err);
      }
    }

    return NextResponse.json({
      ok: true,
      home_id,
      sent,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
