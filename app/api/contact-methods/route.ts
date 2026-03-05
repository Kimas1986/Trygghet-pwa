import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

type Body = {
  home_id: string;
  phone: string; // "90012345" eller "+4790012345"
  sms_enabled?: boolean;
};

function requireBearer(req: Request) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer (.+)$/);
  const token = m?.[1];
  if (!token) throw new Error("Missing Authorization Bearer token");
  return token;
}

function normalizePhoneToE164(raw: string) {
  const s = String(raw || "").trim();

  // allerede +...
  if (s.startsWith("+")) return s.replace(/\s+/g, "");

  // bare siffer
  const digits = s.replace(/\D+/g, "");

  // norsk 8-siffer
  if (digits.length === 8) return `+47${digits}`;

  // hvis noen skriver 0047....
  if (digits.startsWith("0047") && digits.length >= 12) return `+${digits.slice(2)}`;

  // fallback: prøv +digits
  if (digits.length >= 9) return `+${digits}`;

  throw new Error("Invalid phone number");
}

export async function POST(req: Request) {
  try {
    const accessToken = requireBearer(req);

    const body = (await req.json()) as Body;
    const home_id = String(body.home_id || "").trim();
    const phone_raw = String(body.phone || "").trim();
    const sms_enabled = body.sms_enabled !== false;

    if (!home_id) return NextResponse.json({ error: "Missing home_id" }, { status: 400 });
    if (!phone_raw) return NextResponse.json({ error: "Missing phone" }, { status: 400 });

    const phone_e164 = normalizePhoneToE164(phone_raw);

    // 1) Bruker-client for å finne user_id (RLS-safe)
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr) return NextResponse.json({ error: userErr.message }, { status: 401 });

    const user_id = userData.user?.id;
    if (!user_id) return NextResponse.json({ error: "No user" }, { status: 401 });

    // 2) Service role for å insert/upsert uansett RLS
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    // Upsert på (home_id, user_id) – krever unik constraint, hvis ikke finnes: vi gjør “insert” og tåler duplikat med delete senere.
    // Vi prøver upsert først.
    const { error: upErr } = await admin
      .from("contact_methods")
      .upsert(
        {
          home_id,
          user_id,
          phone_e164,
          sms_enabled,
        },
        { onConflict: "home_id,user_id" }
      );

    if (upErr) {
      // fallback til insert hvis onConflict ikke finnes
      const { error: insErr } = await admin.from("contact_methods").insert({
        home_id,
        user_id,
        phone_e164,
        sms_enabled,
      });
      if (insErr) throw new Error(insErr.message);
    }

    return NextResponse.json({ ok: true, home_id, user_id, phone_e164, sms_enabled });
  } catch (e: any) {
    const msg = e?.message ?? "Unknown error";
    const status = msg.includes("Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}