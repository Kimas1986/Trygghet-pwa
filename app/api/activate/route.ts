import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

type Body = {
  product_code: string;
  home_id: string;
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

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr) throw new Error(userErr.message);

    const user = userData.user;
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as Body;

    const code = String(body.product_code || "").trim();
    const home_id = String(body.home_id || "").trim();

    if (!code) {
      return NextResponse.json({ error: "Missing product_code" }, { status: 400 });
    }

    if (!home_id) {
      return NextResponse.json({ error: "Missing home_id" }, { status: 400 });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const { data: pkg, error: pkgErr } = await admin
      .from("product_packages")
      .select("id, product_code, claimed_at, home_id")
      .eq("product_code", code)
      .maybeSingle();

    if (pkgErr) throw new Error(pkgErr.message);

    if (!pkg) {
      return NextResponse.json({ error: "Ukjent produktkode" }, { status: 404 });
    }

    if (pkg.claimed_at && pkg.home_id && String(pkg.home_id) !== home_id) {
      return NextResponse.json(
        { error: "Produktpakken er allerede knyttet til et annet hus" },
        { status: 409 }
      );
    }

    const { error: updateErr } = await admin
      .from("product_packages")
      .update({
        claimed_at: new Date().toISOString(),
        claimed_by: user.id,
        home_id,
      })
      .eq("id", pkg.id);

    if (updateErr) throw new Error(updateErr.message);

    return NextResponse.json({ ok: true, product_code: code, home_id });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}