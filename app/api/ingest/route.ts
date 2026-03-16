import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  buildHomePatchFromIngest,
  resolveAwayPatchFromIngest,
} from "@/lib/server/state-engine";

const INGEST_SECRET = process.env.INGEST_SECRET || "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const RETURN_HOME_WINDOW_MINUTES = 5;

function parseIsoOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;

  return d.toISOString();
}

function parseBooleanOrUndefined(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;

  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }

  return undefined;
}

function getAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase env mangler");
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

async function resolveHomeIdFromProductCode(product_code: string): Promise<string | null> {
  if (!product_code) return null;

  const admin = getAdminClient();

  const { data: pkg, error } = await admin
    .from("product_packages")
    .select("product_code, home_id, claimed_at")
    .eq("product_code", product_code)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!pkg) {
    return null;
  }

  const homeId = typeof pkg.home_id === "string" ? pkg.home_id.trim() : "";
  if (!homeId) {
    return null;
  }

  return homeId;
}

export async function POST(req: Request) {
  try {
    const urlObj = new URL(req.url);
    const secretQuery = urlObj.searchParams.get("secret") || "";
    const secretHeader = req.headers.get("x-ingest-secret") || "";

    if (INGEST_SECRET && secretQuery !== INGEST_SECRET && secretHeader !== INGEST_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    const product_code = String(body.product_code ?? "").trim().toUpperCase();
    const home_id_input = String(body.home_id ?? "").trim();

    const motionBool = body.motion === true;
    const door_open = body.door_open === true;
    const heartbeat = body.heartbeat === true;

    const batteryLow = parseBooleanOrUndefined(body.battery_low);
    const systemOk = parseBooleanOrUndefined(body.system_ok);

    if (!home_id_input && !product_code) {
      return NextResponse.json({ error: "Missing home_id or product_code" }, { status: 400 });
    }

    let home_id = home_id_input;

    if (!home_id && product_code) {
      const resolved = await resolveHomeIdFromProductCode(product_code);

      if (!resolved) {
        return NextResponse.json(
          { error: "Ugyldig eller ikke aktivert produktkode" },
          { status: 400 }
        );
      }

      home_id = resolved;
    }

    if (!home_id) {
      return NextResponse.json({ error: "Kunne ikke finne home_id" }, { status: 400 });
    }

    const admin = getAdminClient();

    const { data: existingHome, error: existingErr } = await admin
      .from("homes")
      .select(
        "id, home_id, state, mode, last_seen, last_motion, last_alert_window, last_alert_time, pending_away_since, last_door_at, mode_updated_at"
      )
      .eq("home_id", home_id)
      .maybeSingle();

    if (existingErr) {
      return NextResponse.json({ error: `homes lookup: ${existingErr.message}` }, { status: 500 });
    }

    if (!existingHome) {
      return NextResponse.json(
        { error: `Fant ikke home i Supabase homes for ${home_id}` },
        { status: 404 }
      );
    }

    const motionIso =
      parseIsoOrNull(body.last_motion_at) ??
      parseIsoOrNull(body.last_motion) ??
      null;

    const seenIso =
      parseIsoOrNull(body.last_seen_at) ??
      parseIsoOrNull(body.last_seen) ??
      null;

    const now = new Date();

    const baseFields = buildHomePatchFromIngest(
      {
        motion: motionBool,
        door_open,
        heartbeat,
        battery_low: batteryLow,
        system_ok: systemOk,
        last_motion_at: motionIso,
        last_seen_at: seenIso,
      },
      now
    ) as Record<string, unknown>;

    const awayFields = resolveAwayPatchFromIngest(
      {
        mode: existingHome.mode,
        last_door_at: existingHome.last_door_at,
        pending_away_since: existingHome.pending_away_since,
      },
      {
        motion: motionBool,
        door_open,
        heartbeat,
        battery_low: batteryLow,
        system_ok: systemOk,
        last_motion_at: motionIso,
        last_seen_at: seenIso,
      },
      {
        now,
        returnHomeWindowMinutes: RETURN_HOME_WINDOW_MINUTES,
      }
    ) as Record<string, unknown>;

    const fields: Record<string, unknown> = {
      ...baseFields,
      ...awayFields,
    };

    const { data: updatedHome, error: updateErr } = await admin
      .from("homes")
      .update(fields)
      .eq("home_id", home_id)
      .select()
      .maybeSingle();

    if (updateErr) {
      return NextResponse.json({ error: `homes update: ${updateErr.message}` }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      home_id,
      wrote: fields,
      updated: updatedHome,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
