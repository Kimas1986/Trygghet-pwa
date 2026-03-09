import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const INGEST_SECRET = process.env.INGEST_SECRET || "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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

    // Hjemmet må allerede finnes i homes.
    const { data: existingHome, error: existingErr } = await admin
      .from("homes")
      .select("id, home_id, state")
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

    const nowIso = new Date().toISOString();

    const fields: Record<string, unknown> = {
      last_seen: seenIso ?? nowIso,
    };

    if (batteryLow !== undefined) {
      fields.battery_low = batteryLow;
    }

    if (systemOk !== undefined) {
      fields.system_ok = systemOk;
    }

    if (door_open) {
      fields.mode = "away";
      fields.mode_updated_at = nowIso;
      fields.state = "green";
    }

    if (motionBool || motionIso) {
      fields.last_motion = motionIso ?? nowIso;
      fields.mode = "home";
      fields.mode_updated_at = nowIso;
      fields.state = "green";
    }

    // Ved ren heartbeat oppdaterer vi bare last_seen (+ evt battery/system),
    // og lar state være urørt.
    if (heartbeat && !motionBool && !motionIso && !door_open) {
      // bevisst ingen ekstra state-endring her
    }

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