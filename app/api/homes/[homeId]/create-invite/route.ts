import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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

function rand(n = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ homeId: string }> }
) {
  try {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json(
        { error: "Missing SUPABASE_SERVICE_ROLE_KEY in .env.local" },
        { status: 500 }
      );
    }

    const accessToken = requireBearer(req);
    const { homeId } = await ctx.params;

    const decodedHomeId = decodeURIComponent(homeId || "").trim();
    if (!decodedHomeId) {
      return NextResponse.json({ error: "Missing homeId" }, { status: 400 });
    }

    // User-scoped client (RLS) for membership check
    const supabaseUser = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { data: memberships, error: memErr } = await supabaseUser
      .from("memberships")
      .select("home_id, role");

    if (memErr) {
      return NextResponse.json({ error: memErr.message }, { status: 500 });
    }

    const wanted = norm(decodedHomeId);
    const membership = (memberships ?? []).find((m: any) => norm(m.home_id) === wanted);

    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Optional: kun admin kan lage delingskode
    // Hvis du vil ha det slik, uncomment:
    // if ((membership.role ?? "viewer") !== "admin") {
    //   return NextResponse.json({ error: "Only admin can create invites" }, { status: 403 });
    // }

    // Admin client (service role) for å skrive invites
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const code = `DEL-${rand(6)}`;

    const { error: insErr } = await admin.from("invites").insert({
      code,
      home_id: decodedHomeId,
      role: "viewer",
      max_uses: 10,
      uses: 0,
      expires_at: null,
    });

    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    return NextResponse.json({ code });
  } catch (e: any) {
    const msg = e?.message ?? "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
