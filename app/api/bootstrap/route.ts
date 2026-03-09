import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function requireBearer(req: Request) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer (.+)$/);
  const token = m?.[1];
  if (!token) throw new Error("Missing Authorization Bearer token");
  return token;
}

function norm(v: unknown) {
  return String(v ?? "").trim();
}

type MembershipRow = {
  home_id: string | null;
};

type HomeRow = {
  home_id: string;
};

export async function POST(req: Request) {
  try {
    const token = requireBearer(req);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: memberships, error: membershipsError } = await supabase
      .from("memberships")
      .select("home_id");

    if (membershipsError) {
      return NextResponse.json({ error: membershipsError.message }, { status: 500 });
    }

    const membershipRows = (memberships ?? []) as MembershipRow[];

    const ids = Array.from(
      new Set(
        membershipRows
          .map((m) => norm(m.home_id))
          .filter(Boolean)
      )
    );

    if (ids.length === 0) {
      return NextResponse.json({ ok: true, homes: 0, created: 0 });
    }

    const { data: existingHomes, error: existingError } = await supabase
      .from("homes")
      .select("home_id")
      .in("home_id", ids);

    if (existingError) {
      return NextResponse.json({ error: existingError.message }, { status: 500 });
    }

    const existingSet = new Set(
      ((existingHomes ?? []) as HomeRow[]).map((h) => norm(h.home_id)).filter(Boolean)
    );

    const missing = ids.filter((home_id) => !existingSet.has(norm(home_id)));

    if (missing.length === 0) {
      return NextResponse.json({
        ok: true,
        homes: ids.length,
        created: 0,
      });
    }

    const rowsToInsert = missing.map((home_id) => ({
      home_id,
      home_name: home_id,
      state: "green",
      last_seen: new Date().toISOString(),
      battery_low: false,
      last_motion: null,
      last_alert_window: null,
      last_alert_time: null,
      system_ok: true,
      mode: "home",
      mode_updated_at: new Date().toISOString(),
    }));

    const { error: insertError } = await supabase.from("homes").insert(rowsToInsert);

    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      homes: ids.length,
      created: missing.length,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}