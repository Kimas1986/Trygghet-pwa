import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function requireBearer(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  const token = match?.[1];
  if (!token) throw new Error("Missing Authorization Bearer token");
  return token;
}

function norm(s: unknown) {
  return String(s ?? "").trim();
}

function normKey(s: unknown) {
  return String(s ?? "").trim().toUpperCase();
}

type MembershipRow = {
  home_id: string | null;
  role: string | null;
};

async function ensureMembership(accessToken: string, homeId: string) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const { data, error } = await supabase.from("memberships").select("home_id, role");

  if (error) {
    throw new Error(error.message);
  }

  const wanted = normKey(homeId);
  const rows = (data ?? []) as MembershipRow[];
  const match = rows.find((m) => normKey(m.home_id) === wanted);
  return match ?? null;
}

export async function POST(req: Request) {
  try {
    const accessToken = requireBearer(req);

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const home_id = norm(body.home_id);
    const name = norm(body.name);

    if (!home_id || !name) {
      return NextResponse.json({ error: "Missing home_id or name" }, { status: 400 });
    }

    if (name.length < 2) {
      return NextResponse.json({ error: "Ugyldig navn (minst 2 tegn)." }, { status: 400 });
    }

    if (name.length > 60) {
      return NextResponse.json({ error: "Navnet er for langt (maks 60 tegn)." }, { status: 400 });
    }

    // Samme tilgangsnivå som før: alle medlemmer av hjemmet får lov
    const membership = await ensureMembership(accessToken, home_id);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { data: updated, error: updateError } = await supabase
      .from("homes")
      .update({ home_name: name })
      .eq("home_id", home_id)
      .select("home_id, home_name")
      .maybeSingle();

    if (updateError) {
      throw new Error(updateError.message);
    }

    if (!updated) {
      return NextResponse.json({ error: "Home not found in Supabase" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      home_id: updated.home_id,
      name: updated.home_name,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
