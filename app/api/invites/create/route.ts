import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function json(status: number, data: any) {
  return NextResponse.json(data, { status });
}

function requireBearer(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  const token = match?.[1];
  if (!token) throw new Error("Missing Authorization Bearer token");
  return token;
}

function norm(v: any) {
  return String(v ?? "").trim();
}

function randomCode(len = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export async function POST(req: Request) {
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON) return json(500, { error: "Supabase env missing" });
    if (!SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "SUPABASE_SERVICE_ROLE_KEY missing" });

    const token = requireBearer(req);

    const body = await req.json().catch(() => ({}));
    const home_id = norm(body?.home_id);
    if (!home_id) return json(400, { error: "Missing home_id" });

    // 1) brukerklient: sjekk token + admin rolle
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: me, error: meErr } = await userClient.auth.getUser();
    if (meErr || !me?.user) return json(401, { error: "Unauthorized" });

    const { data: membership, error: mErr } = await userClient
      .from("memberships")
      .select("role, home_id")
      .eq("home_id", home_id)
      .maybeSingle();

    if (mErr) return json(500, { error: mErr.message });

    const role = String(membership?.role ?? "").toLowerCase();
    if (role !== "admin") return json(403, { error: "Forbidden (admin only)" });

    // 2) admin klient: insert i invites
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    for (let i = 0; i < 12; i++) {
      const invite_code = randomCode(8);

      // ✅ kompat: noen schema bruker "code" (NOT NULL), andre "invite_code"
      const payload: any = {
        home_id,
        invite_code,
        code: invite_code, // <— viktig!
        created_by: me.user.id,
        expires_at,
        used: false,
      };

      const { error: insErr } = await admin.from("invites").insert(payload);

      if (!insErr) return json(200, { ok: true, home_id, invite_code, expires_at });

      const msg = String(insErr.message || "");
      if (msg.toLowerCase().includes("duplicate")) continue;
      if (msg.toLowerCase().includes("null value in column") && msg.toLowerCase().includes("code")) continue;

      return json(500, { error: msg });
    }

    return json(500, { error: "Could not generate unique invite_code" });
  } catch (e: any) {
    const msg = e?.message ?? "Unknown error";
    const lower = String(msg).toLowerCase();
    const isAuth =
      lower.includes("missing authorization") ||
      lower.includes("jwt expired") ||
      lower.includes("invalid jwt") ||
      (lower.includes("token") && lower.includes("expired"));

    return json(isAuth ? 401 : 500, { error: msg });
  }
}
