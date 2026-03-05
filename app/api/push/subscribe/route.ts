import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

type Body = {
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  home_id: string | null;
  user_agent?: string | null;
};

function requireBearer(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  const token = match?.[1];
  if (!token) throw new Error("Missing Authorization Bearer token");
  return token;
}

export async function POST(req: Request) {
  try {
    const accessToken = requireBearer(req);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    // Hent user (for å få user_id)
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr) throw new Error(userErr.message);
    if (!userData?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await req.json()) as Body;

    const endpoint = body?.subscription?.endpoint;
    const p256dh = body?.subscription?.keys?.p256dh;
    const authKey = body?.subscription?.keys?.auth;

    if (!endpoint || !p256dh || !authKey) {
      return NextResponse.json({ error: "Missing subscription fields" }, { status: 400 });
    }

    const { error } = await supabase
      .from("push_subscriptions")
      .upsert(
        {
          user_id: userData.user.id,
          home_id: body.home_id,
          endpoint,
          p256dh,
          auth: authKey,
          user_agent: body.user_agent ?? null,
        },
        { onConflict: "endpoint" }
      );

    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const msg = e?.message ?? "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}