import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

type Body = { product_code: string; home_id: string };

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

    // user from anon + bearer
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false },
    });

    const { data: u, error: uErr } = await userClient.auth.getUser();
    if (uErr) throw new Error(uErr.message);
    const user = u.user;
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await req.json()) as Body;
    const code = String(body.product_code || "").trim();
    const home_id = String(body.home_id || "").trim();
    if (!code) return NextResponse.json({ error: "Missing product_code" }, { status: 400 });
    if (!home_id) return NextResponse.json({ error: "Missing home_id" }, { status: 400 });

    // service role for claim
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Finn pakken
    const { data: pkg, error: pErr } = await admin
      .from("product_packages")
      .select("id, code, claimed_at, home_id")
      .eq("code", code)
      .maybeSingle();

    if (pErr) throw new Error(pErr.message);
    if (!pkg) return NextResponse.json({ error: "Ukjent produktkode" }, { status: 404 });

    // Hvis allerede claimet til annet home -> stopp
    if (pkg.claimed_at && pkg.home_id && String(pkg.home_id) !== home_id) {
      return NextResponse.json({ error: "Produktpakken er allerede knyttet til et annet hus" }, { status: 409 });
    }

    // Claim (idempotent)
    const { error: upErr } = await admin
      .from("product_packages")
      .update({
        claimed_at: new Date().toISOString(),
        claimed_by: user.id,
        home_id,
      })
      .eq("id", pkg.id);

    if (upErr) throw new Error(upErr.message);

    return NextResponse.json({ ok: true, code, home_id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}