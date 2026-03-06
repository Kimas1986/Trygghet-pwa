import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const INGEST_SECRET = process.env.INGEST_SECRET || "";

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID!;
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY!;
const HOMES = process.env.AIRTABLE_HOMES_TABLE || "Homes";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function airtableFetch(url: string, init?: RequestInit) {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${AIRTABLE_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
}

async function airtableFindByFormula(table: string, formula: string, maxRecords = 1) {
  const url =
    `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}` +
    `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=${maxRecords}`;

  const res = await airtableFetch(url, { method: "GET" });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Airtable find failed (${table}): ${t}`);
  }

  const j = await res.json();
  return (j.records ?? []) as Array<{ id: string; fields: Record<string, unknown> }>;
}

async function upsertHomeByHomeId(home_id: string, fields: Record<string, unknown>) {
  const recs = await airtableFindByFormula(
    HOMES,
    `{home_id}="${home_id.replace(/"/g, '\\"')}"`,
    1
  );

  if (recs.length) {
    const recordId = recs[0].id;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(HOMES)}/${recordId}`;
    const res = await airtableFetch(url, {
      method: "PATCH",
      body: JSON.stringify({ fields }),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Airtable Homes PATCH failed: ${t}`);
    }

    return { created: false, recordId };
  }

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(HOMES)}`;
  const res = await airtableFetch(url, {
    method: "POST",
    body: JSON.stringify({ records: [{ fields: { home_id, ...fields } }] }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Airtable Homes CREATE failed: ${t}`);
  }

  const j = await res.json();
  return { created: true, recordId: j.records?.[0]?.id ?? null };
}

function parseIsoOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;

  return d.toISOString();
}

async function resolveHomeIdFromProductCode(product_code: string): Promise<string | null> {
  if (!product_code) return null;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase env mangler");
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: pkg, error } = await admin
    .from("product_packages")
    .select("product_code, home_id, claimed_at")
    .eq("product_code", product_code)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!pkg) return null;

  const homeId = typeof pkg.home_id === "string" ? pkg.home_id.trim() : "";
  if (!homeId) {
    // Produktkoden finnes, men er ikke aktivert/claimet ennå
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

    const motionIso =
      parseIsoOrNull(body.last_motion_at) ??
      parseIsoOrNull(body.last_motion) ??
      null;

    const seenIso =
      parseIsoOrNull(body.last_seen_at) ??
      parseIsoOrNull(body.last_seen) ??
      null;

    const nowIso = new Date().toISOString();

    const fields: Record<string, unknown> = {};

    fields.last_seen = seenIso ?? nowIso;

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

    if (heartbeat && !motionBool && !motionIso && !door_open) {
      const existing = await airtableFindByFormula(
        HOMES,
        `{home_id}="${home_id.replace(/"/g, '\\"')}"`,
        1
      );

      const curState = String(existing?.[0]?.fields?.state ?? "")
        .trim()
        .toLowerCase();

      if (!curState) {
        fields.state = "green";
      }
    }

    const result = await upsertHomeByHomeId(home_id, fields);

    return NextResponse.json({
      ok: true,
      home_id,
      wrote: fields,
      upsert: result,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}