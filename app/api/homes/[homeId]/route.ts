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
  return v === true || v === "true";
}

async function airtableList(tableName: string, query: string) {
  const url =
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}` +
    (query ? `?${query}` : "");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Airtable ${tableName} error (${res.status}): ${text}`);
  }

  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  return json.records ?? [];
}

async function ensureMembership(accessToken: string, homeId: string) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const { data, error } = await supabase.from("memberships").select("home_id, role");
  if (error) throw new Error(error.message);

  const wanted = norm(homeId);
  const match = (data ?? []).find((m: any) => norm(m.home_id) === wanted);
  return match ?? null;
}

function matchesHome(homeIdField: any, homeKey: string, homeRecordId: string) {
  if (Array.isArray(homeIdField)) return homeRecordId ? homeIdField.includes(homeRecordId) : false;
  if (typeof homeIdField === "string") return norm(homeIdField) === norm(homeKey);
  return false;
}

function getAckBy(fields: Record<string, any>): string | null {
  return asString(
    pickFirst(fields, [
      "ack_by",
      "acknowledged_by",
      "ack_by_email",
      "ack_email",
      "acked_by",
      "acked_by_email",
    ])
  );
}

function getAckAt(fields: Record<string, any>): string | null {
  return asString(pickFirst(fields, ["acknowledged_at", "ack_at", "ack_time", "acked_at"]));
}

export async function GET(req: Request, ctx: { params: { homeId: string } }) {
  try {
    const accessToken = requireBearer(req);
    const rawHomeId = ctx?.params?.homeId ?? "";
    const homeId = decodeURIComponent(String(rawHomeId)).trim();

    if (!homeId) {
      return NextResponse.json({ error: "Missing homeId" }, { status: 400 });
    }

    // 1) Membership
    const membership = await ensureMembership(accessToken, homeId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // 2) Home record
    const homeFormula = `{home_id}="${homeId.replace(/"/g, '\\"')}"`;
    const homeRecords = await airtableList(
      AIRTABLE_HOMES_TABLE,
      `filterByFormula=${encodeURIComponent(homeFormula)}&maxRecords=1`
    );

    const homeRec = homeRecords?.[0] ?? null;
    const homeFields = homeRec?.fields ?? {};
    const homeRecordId: string = homeRec?.id ?? "";

    const home_name =
      (pickFirst(homeFields ?? {}, ["home_name", "name", "display_name", "title"]) as string | null) ??
      null;

    const home = {
      home_id: homeId,
      home_name, // ✅ NYTT (for å vise navnet på detaljsiden)
      role: membership.role ?? "viewer",
      state: asString(homeFields.state),
      last_seen: asString(homeFields.last_seen),
      last_motion: asString(homeFields.last_motion),
      battery_low: asBool(homeFields.battery_low),
      last_alert_window: asString(homeFields.last_alert_window),
      last_alert_time: asString(homeFields.last_alert_time),
    };

    // 3) Alerts list (nyeste først)
    const alertsRaw = await airtableList(
      AIRTABLE_ALERTS_TABLE,
      `sort[0][field]=triggered_at&sort[0][direction]=desc&maxRecords=200`
    );

    const relevant = (alertsRaw ?? []).filter((a: any) =>
      matchesHome(a.fields?.home_id, homeId, homeRecordId)
    );

    const alerts = relevant.map((a: any) => {
      const f = a.fields ?? {};
      const acknowledged = asBool(pickFirst(f, ["acknowledged", "acked", "is_acknowledged"]));
      const acknowledged_at = getAckAt(f);
      const ack_by = getAckBy(f);

      return {
        alert_id: a.id,
        home_id: homeId,
        type: asString(f.type),
        window: asString(f.window),
        triggered_at: asString(f.triggered_at),
        acknowledged: acknowledged || Boolean(acknowledged_at),
        acknowledged_at,
        ack_by,
        resolved_at: asString(pickFirst(f, ["resolved_at", "closed_at", "ended_at"])),
      };
    });

    return NextResponse.json({ home, alerts });
  } catch (e: any) {
    const msg = e?.message ?? "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}