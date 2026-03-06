import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status });
}

function norm(v: unknown) {
  return String(v ?? "").trim();
}

function toE164Norway(raw: string) {
  const s = norm(raw).replace(/\s+/g, "").replace(/[^\d+]/g, "");
  if (!s) return "";
  if (s.startsWith("+")) return s;
  if (/^\d{8}$/.test(s)) return `+47${s}`;
  if (/^\d{9,15}$/.test(s)) return `+${s}`;
  return "";
}

function newHomeId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "HUS_";
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

type RegisterBody = {
  email?: string;
  password?: string;
  phone?: string;
  product_code?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as RegisterBody;

    const email = norm(body.email).toLowerCase();
    const password = String(body.password ?? "");
    const phoneRaw = norm(body.phone);
    const productCode = norm(body.product_code);

    if (!email || !email.includes("@")) {
      return json(400, { error: "Ugyldig e-post" });
    }

    if (!password || password.length < 6) {
      return json(400, { error: "Passord må være minst 6 tegn" });
    }

    if (!productCode) {
      return json(400, { error: "Produktkode mangler" });
    }

    const phone_e164 = toE164Norway(phoneRaw);
    if (!phone_e164) {
      return json(400, { error: "Ugyldig telefonnummer" });
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { error: "Supabase env mangler" });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // 1) Produktkode må finnes og ikke være i bruk
    const { data: pkg, error: pkgErr } = await admin
      .from("product_packages")
      .select("id, product_code, home_id, claimed_at, claimed_by")
      .eq("product_code", productCode)
      .maybeSingle();

    if (pkgErr) {
      return json(500, { error: pkgErr.message });
    }

    if (!pkg) {
      return json(400, { error: "Ugyldig produktkode (finnes ikke)" });
    }

    if (pkg.home_id) {
      return json(400, { error: "Produktkode er allerede i bruk" });
    }

    // 2) Opprett bruker
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { phone_e164 },
    });

    if (createErr) {
      return json(400, { error: createErr.message });
    }

    const userId = created.user?.id;
    if (!userId) {
      return json(500, { error: "Kunne ikke opprette bruker" });
    }

    // 3) Lag home_id og claim produktkoden FØRST
    const home_id = newHomeId();

    const { data: claimedRows, error: claimErr } = await admin
      .from("product_packages")
      .update({
        home_id,
        claimed_at: new Date().toISOString(),
        claimed_by: userId,
      })
      .eq("id", pkg.id)
      .is("home_id", null)
      .select("id, product_code, home_id");

    if (claimErr) {
      return json(500, { error: `product_packages claim: ${claimErr.message}` });
    }

    if (!claimedRows || claimedRows.length !== 1) {
      return json(409, { error: "Produktkode ble claimet av en annen prosess. Prøv igjen." });
    }

    // 4) Nå er produktkoden låst. Opprett membership.
    const { error: mErr } = await admin.from("memberships").insert({
      user_id: userId,
      home_id,
      role: "admin",
    });

    if (mErr) {
      return json(500, { error: `memberships: ${mErr.message}` });
    }

    // 5) Opprett contact_methods
    const { error: cErr } = await admin.from("contact_methods").insert({
      user_id: userId,
      home_id,
      phone_e164,
      sms_enabled: true,
    });

    if (cErr) {
      return json(500, { error: `contact_methods: ${cErr.message}` });
    }

    return json(200, { ok: true, home_id });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return json(500, { error: msg });
  }
}