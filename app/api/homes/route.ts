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

function asBool(v: any): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
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

function matchesHome(homeIdField: any, homeKey: string, homeRecordId: string) {
  if (Array.isArray(homeIdField)) return homeIdField.includes(homeRecordId);
  if (typeof homeIdField === "string") return norm(homeIdField) === norm(homeKey);
  return false;
}

function getAckInfo(fields: Record<string, any>) {
  const ackBool = asBool(pickFirst(fields, ["acknowledged", "acked", "is_acknowledged"]));
  const ackAt = asString(pickFirst(fields, ["acknowledged_at", "ack_at", "ack_time", "acked_at"]));
  const ackBy = asString(pickFirst(fields, ["ack_by", "acknowledged_by", "ack_by_email", "ack_email"]));

  const acknowledged = ackBool === true || Boolean(ackAt);
  return { acknowledged, acknowledged_at: ackAt, ack_by: ackBy };
}

function isAlertOpen(fields: Record<string, any>) {
  const { acknowledged, acknowledged_at } = getAckInfo(fields);

  const closedAt = asString(pickFirst(fields, ["closed_at", "resolved_at", "ended_at"]));
  const status = asString(pickFirst(fields, ["status", "state", "alert_state"]));
  const statusLower = (status || "").toLowerCase();
  const explicitlyClosed = ["closed", "resolved", "done"].includes(statusLower);

  if (closedAt) return false;
  if (explicitlyClosed) return false;
  if (acknowledged) return false;
  if (acknowledged_at) return false;

  return true;
}

export async function GET(req: Request) {
  try {
    const accessToken = requireBearer(req);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { data: memberships, error } = await supabase
      .from("memberships")
      .select("home_id, role");

    if (error) throw new Error(error.message);

    const homeIds = (memberships ?? [])
      .map((m: any) => String(m.home_id ?? "").trim())
      .filter(Boolean);

    if (homeIds.length === 0) {
      return NextResponse.json({ homes: [] });
    }

    const orFormula =
      "OR(" +
      homeIds.map((h) => `{home_id}="${h.replace(/"/g, '\\"')}"`).join(",") +
      ")";

    const homesRecords = await airtableList(
      AIRTABLE_HOMES_TABLE,
      `filterByFormula=${encodeURIComponent(orFormula)}&maxRecords=100`
    );

    const homeMap = new Map<string, { recordId: string; fields: Record<string, any> }>();
    for (const r of homesRecords) {
      const f = r.fields ?? {};
      const key = String(f.home_id ?? "").trim();
      if (!key) continue;
      homeMap.set(norm(key), { recordId: r.id, fields: f });
    }

    // Nyeste først
    const alertsRaw = await airtableList(
      AIRTABLE_ALERTS_TABLE,
      `sort[0][field]=triggered_at&sort[0][direction]=desc&maxRecords=200`
    );

    const homes = homeIds.map((hid) => {
      const membership = (memberships ?? []).find((m: any) => norm(m.home_id) === norm(hid));
      const hRec = homeMap.get(norm(hid));
      const homeFields = hRec?.fields ?? {};

      const relevantAlerts = (alertsRaw ?? []).filter((a: any) =>
        matchesHome(a.fields?.home_id, hid, hRec?.recordId ?? "__NO_REC__")
      );

      // Nyeste alert uansett ack/open (for "Sjekket!")
      const latest = relevantAlerts[0] ?? null;

      // Første åpne alert (om du trenger den andre steder)
      const open = relevantAlerts.find((a: any) => isAlertOpen(a.fields ?? {})) ?? null;

      // Nyeste ack (for "Sist sjekket")
      const lastAck =
        relevantAlerts.find(
          (a: any) => !isAlertOpen(a.fields ?? {}) && getAckInfo(a.fields ?? {}).acknowledged
        ) ?? null;

      const latest_open_alert = open
        ? {
            alert_id: open.id,
            type: asString(open.fields?.type),
            window: asString(open.fields?.window),
            triggered_at: asString(open.fields?.triggered_at),
          }
        : null;

      const latest_alert = latest
        ? {
            alert_id: latest.id,
            type: asString(latest.fields?.type),
            window: asString(latest.fields?.window),
            triggered_at: asString(latest.fields?.triggered_at),
            ...getAckInfo(latest.fields ?? {}),
          }
        : null;

      const last_checked = lastAck
        ? {
            acknowledged_at: asString(
              pickFirst(lastAck.fields ?? {}, ["acknowledged_at", "ack_time", "ack_at", "acked_at"])
            ),
            ack_by: asString(
              pickFirst(lastAck.fields ?? {}, ["ack_by", "acknowledged_by", "ack_by_email", "ack_email"])
            ),
          }
        : null;

      const home_name =
        (pickFirst(homeFields ?? {}, ["home_name", "name", "display_name", "title"]) as string | null) ?? null;

      return {
        home_id: hid,
        home_name,
        role: membership?.role ?? "viewer",

        state: asString(homeFields.state),
        last_seen: asString(homeFields.last_seen),
        last_motion: asString(homeFields.last_motion),
        battery_low: asBool(homeFields.battery_low),

        latest_open_alert,
        latest_alert,
        last_checked,
      };
    });

    return NextResponse.json({ homes });
  } catch (e: any) {
    const msg = e?.message ?? "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}