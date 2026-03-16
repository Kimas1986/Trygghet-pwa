import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function json(status: number, data: any) {
  return NextResponse.json(data, { status });
}

function norm(v: any) {
  return String(v ?? "").trim();
}

function toE164Norway(raw: string) {
  let s = norm(raw).replace(/\s+/g, "").replace(/[^\d+]/g, "");
  if (!s) return "";
  if (s.startsWith("+")) return s;
  if (/^\d{8}$/.test(s)) return `+47${s}`;
  if (/^\d{9,15}$/.test(s)) return `+${s}`;
  return "";
}

function requireBearer(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  const token = match?.[1];
  return token || null;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

    const code = norm(body?.code);
    const phoneRaw = norm(body?.phone);
    const phone_e164 = toE164Norway(phoneRaw);

    if (!code) return json(400, { error: "Kode mangler" });
    if (!phone_e164) return json(400, { error: "Ugyldig telefonnummer" });

    const token = requireBearer(req);

    // Admin client
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // 1) Finn invite (aksepter både code og invite_code)
    const { data: inv, error: invErr } = await admin
      .from("invites")
      .select("id, home_id, code, invite_code, expires_at, used")
      .or(`code.eq.${code},invite_code.eq.${code}`)
      .maybeSingle();

    if (invErr) return json(500, { error: invErr.message });
    if (!inv) return json(400, { error: "Ugyldig kode" });

    const home_id = norm(inv.home_id);
    if (!home_id) return json(500, { error: "Invite mangler home_id" });

    if (inv.expires_at) {
      const exp = new Date(String(inv.expires_at));
      if (!Number.isNaN(exp.getTime()) && Date.now() > exp.getTime()) {
        return json(400, { error: "Koden er utløpt" });
      }
    }

    // 2) Finn/lag bruker
    let user_id: string | null = null;

    if (token) {
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data: me, error: meErr } = await userClient.auth.getUser();
      if (meErr || !me?.user) return json(401, { error: "Innlogging utløpt. Logg inn på nytt." });
      user_id = me.user.id;
    } else {
      const email = norm(body?.email).toLowerCase();
      const password = String(body?.password ?? "");
      if (!email || !email.includes("@")) return json(400, { error: "E-post mangler/ugyldig" });
      if (!password || password.length < 6) return json(400, { error: "Passord må være minst 6 tegn" });

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // MVP: ingen e-post-bekreftelse
        user_metadata: { phone_e164 },
      });
      if (createErr) return json(400, { error: createErr.message });

      user_id = created.user?.id ?? null;
      if (!user_id) return json(500, { error: "Kunne ikke opprette bruker" });
    }

    // 3) Legg til membership (viewer) - idempotent
    // Hvis du har unique constraint på (user_id, home_id) er dette best:
    // (hvis ikke: si fra, så gjør vi det)
    const { error: mErr } = await admin.from("memberships").upsert(
      { user_id, home_id, role: "viewer" },
      { onConflict: "user_id,home_id" }
    );
    if (mErr) return json(500, { error: `memberships: ${mErr.message}` });

    // 4) Lagre/oppdater telefon for sms på dette hjemmet
    const { error: cErr } = await admin.from("contact_methods").upsert(
      { user_id, home_id, phone_e164, sms_enabled: true },
      { onConflict: "user_id,home_id" }
    );
    if (cErr) return json(500, { error: `contact_methods: ${cErr.message}` });

    // (valgfritt) merk invite brukt av denne user (men la den fortsatt kunne brukes av flere)
// Ikke la dette stoppe join hvis det feiler
try {
  const { error: uErr } = await admin
    .from("invites")
    .update({ used: true, used_at: new Date().toISOString(), used_by: user_id })
    .eq("id", inv.id);

  // ignorer feil
  void uErr;
} catch {
  // ignorer
}

    return json(200, { ok: true, home_id });
  } catch (e: any) {
    return json(500, { error: e?.message ?? "Unknown error" });
  }
}
