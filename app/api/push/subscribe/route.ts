import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function requireBearer(req: Request) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer (.+)$/);
  const token = m?.[1];
  if (!token) throw new Error("Missing Authorization Bearer token");
  return token;
}

export async function POST(req: Request) {
  try {
    const accessToken = requireBearer(req);
    const body = await req.json().catch(() => ({} as any));

    const endpoint = String(body?.endpoint ?? "");
    const p256dh = String(body?.keys?.p256dh ?? "");
    const auth = String(body?.keys?.auth ?? "");

    if (!endpoint || !p256dh || !auth) {
      return NextResponse.json({ error: "Missing subscription fields" }, { status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr) throw new Error(userErr.message);

    const user_id = userData?.user?.id;
    if (!user_id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Upsert-ish: endpoint is unique, so delete+insert if conflict
    const { error: insertErr } = await supabase.from("push_subscriptions").insert({
      user_id,
      endpoint,
      p256dh,
      auth,
    });

    if (!insertErr) return NextResponse.json({ ok: true });

    if ((insertErr as any)?.code === "23505") {
      const { error: delErr } = await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
      if (delErr) throw new Error(delErr.message);

      const { error: ins2 } = await supabase.from("push_subscriptions").insert({
        user_id,
        endpoint,
        p256dh,
        auth,
      });
      if (ins2) throw new Error(ins2.message);

      return NextResponse.json({ ok: true, replaced: true });
    }

    throw new Error(insertErr.message);
  } catch (e: any) {
    const msg = e?.message ?? "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}