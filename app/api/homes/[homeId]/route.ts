import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY!;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;
const AIRTABLE_HOMES_TABLE = process.env.AIRTABLE_HOMES_TABLE || "Homes";
const AIRTABLE_ALERTS_TABLE = process.env.AIRTABLE_ALERTS_TABLE || "Alerts";

function requireBearer(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  const token = match?.[1];
  if (!token) throw new Error("Missing Authorization Bearer token");
  return token;
}

function norm(s: string) {
  return (s || "").trim().toUpperCase();
}

function pickFirst(fields: Record<string, unknown>, keys: string[]) {
  for (const k of keys) {
    const v = (fields as any)?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function asString(v: any): string | null {
  if (typeof v === "string") return v;
  return v == null ? null : String(v);
}

function asBool(v: any): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return Boolean(v);
}

async function airtableList(tableName: string, query: string) {
  const url =
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}` +
    (query ? `?${query}` : "");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable ${tableName} error (${res.status}): ${text}`);
  }

  const json = await res.json();
  return json.records ?? [];
}

async function airtableFindOneByFormula(tableName: string, formula: string) {
  const records = await airtableList(
    tableName,
    `filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`
  );
  return records?.[0] ?? null;
}

async function ensureMembership(accessToken: string, homeId: string) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const { data, error } = await supabase.from("memberships").select("home_id, role");
  if (error) throw new Error(error.message);

  const wanted = norm(homeId);
  return (data ?? []).find((m: any) => norm(m.home_id) === wanted) ?? null;
}

function getAckInfo(fields: Record<string, any>) {
  const ackBool =
    asBool(pickFirst(fields, ["acknowledged", "acked", "is_acknowledged"])) || false;

  const ackAt = asString(
    pickFirst(fields, ["acknowledged_at", "ack_at", "ack_time", "acked_at"])
  );

  const ackBy = asString(
    pickFirst(fields, ["ack_by", "acknowledged_by", "ack_by_email", "ack_email"])
  );

  const acknowledged = Boolean(ackBool) || Boolean(ackAt);
  return { acknowledged, acknowledged_at: ackAt, ack_by: ackBy };
}

function translateAlertRow(a: any) {
  const f = a.fields ?? {};
  const ack = getAckInfo(f);

  return {
    alert_id: a.id,
    home_id: asString(pickFirst(f, ["home_id", "home_key", "home_text"])) ?? "",
    type: asString(f.type),
    window: asString(f.window),
    triggered_at: asString(f.triggered_at),
    acknowledged: ack.acknowledged,
    acknowledged_at: ack.acknowledged_at,
    ack_by: ack.ack_by,
  };
}

// ✅ Next 15-safe signature (params as Promise)
export async function GET(req: Request, ctx: { params: Promise<{ homeId: string }> }) {
  try {
    const accessToken = requireBearer(req);
    const { homeId } = await ctx.params;

    const decodedHomeId = decodeURIComponent(String(homeId || "")).trim();
    if (!decodedHomeId) {
      return NextResponse.json({ error: "Missing homeId" }, { status: 400 });
    }

    // 1) Membership check
    const membership = await ensureMembership(accessToken, decodedHomeId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // 2) Load home from Airtable (by home_id)
    const homeRec = await airtableFindOneByFormula(
      AIRTABLE_HOMES_TABLE,
      `{home_id}="${decodedHomeId.replace(/"/g, '\\"')}"`
    );

    const hf = homeRec?.fields ?? {};
    const home_name =
      (pickFirst(hf, ["name", "home_name", "display_name", "title"]) as string | null) ?? null;

    const home = {
      home_id: decodedHomeId,
      home_name,
      role: membership?.role ?? "viewer",
    };

    // 3) Alerts (latest first) – filter to this home_id
    // NB: Hvis Alerts.home_id er linked record hos deg, må vi justere filtering.
    const alertsRaw = await airtableList(
      AIRTABLE_ALERTS_TABLE,
      `filterByFormula=${encodeURIComponent(
        `{home_id}="${decodedHomeId.replace(/"/g, '\\"')}"`
      )}&sort[0][field]=triggered_at&sort[0][direction]=desc&maxRecords=200`
    );

    const alerts = (alertsRaw ?? []).map(translateAlertRow);

    return NextResponse.json({ home, alerts });
  } catch (e: any) {
    const msg = e?.message ?? "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}