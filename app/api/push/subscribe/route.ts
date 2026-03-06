import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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
    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    const endpoint = String(body?.endpoint ?? "");
    const keys = (body?.keys ?? {}) as Record<string, unknown>;
    const p256dh = String(keys?.p256dh ?? "");
    const auth = String(keys?.auth ?? "");

    if (!endpoint || !p256dh || !auth) {
      return NextResponse.json({ error: "Missing subscription fields" }, { status: 400 });
    }

    // 1) Finn innlogget bruker via bearer-token
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr) throw new Error(userErr.message);

    const user_id = userData?.user?.id;
    if (!user_id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2) Bruk service role for å kunne flytte samme endpoint til ny bruker
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { error } = await admin
      .from("push_subscriptions")
      .upsert(
        {
          user_id,
          endpoint,
          p256dh,
          auth,
        },
        {
          onConflict: "endpoint",
        }
      );

    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}