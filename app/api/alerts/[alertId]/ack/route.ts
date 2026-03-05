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

async function airtableGetRecord(table: string, recordId: string) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
    table
  )}/${encodeURIComponent(recordId)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable get ${table} error (${res.status}): ${text}`);
  }

  return res.json();
}

async function airtableGetAlert(alertId: string) {
  return airtableGetRecord(AIRTABLE_ALERTS_TABLE, alertId);
}

async function airtablePatchAlertRaw(alertId: string, fields: Record<string, any>) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
    AIRTABLE_ALERTS_TABLE
  )}/${encodeURIComponent(alertId)}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify({ fields }),
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

function isUnknownField422(status: number, text: string) {
  return status === 422 && text.includes("UNKNOWN_FIELD_NAME");
}

async function resolveHomeIdFromAlertFields(fields: Record<string, any>): Promise<string | null> {
  // Prefer explicit text fields if you have them
  const direct =
    (pickFirst(fields, ["home_id", "home_key", "home_text", "homeId"]) as string | null) ?? null;

  if (typeof direct === "string" && direct.trim()) return direct.trim();

  // If home_id is a linked record array -> fetch Homes record and read its home_id text field
  const linked = fields?.home_id;
  if (Array.isArray(linked) && linked.length > 0 && typeof linked[0] === "string") {
    const homeRecordId = linked[0];
    const homeRecord = await airtableGetRecord(AIRTABLE_HOMES_TABLE, homeRecordId);
    const hf = homeRecord?.fields ?? {};
    const homeId =
      (pickFirst(hf, ["home_id", "home_key", "home_name", "name"]) as string | null) ?? null;

    if (typeof homeId === "string" && homeId.trim()) return homeId.trim();
  }

  return null;
}

export async function POST(req: Request, ctx: { params: any }) {
  try {
    const accessToken = requireBearer(req);

    // Next kan gi params som vanlig object; du hadde Promise før — vi støtter begge.
    const rawParams = ctx?.params;
    const params = typeof rawParams?.then === "function" ? await rawParams : rawParams;
    const alertId = params?.alertId;

    const decodedAlertId = decodeURIComponent(String(alertId || ""));
    if (!decodedAlertId) {
      return NextResponse.json({ error: "Missing alertId" }, { status: 400 });
    }

    // 1) Hent alert (for home_id + idempotens)
    const alertRecord = await airtableGetAlert(decodedAlertId);
    const f = alertRecord.fields ?? {};

    // 2) Finn homeId (tekst eller via linked record)
    const homeId = await resolveHomeIdFromAlertFields(f);
    if (!homeId) {
      return NextResponse.json(
        {
          error:
            "Alert mangler home_id. Støttet: tekstfelt (home_id/home_key) eller linked record til Homes (med home_id i Homes).",
        },
        { status: 400 }
      );
    }

    // 3) Membership check
    const membership = await ensureMembership(accessToken, homeId);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // 4) Idempotent: hvis allerede ack’et
    const already = Boolean(f.acknowledged ?? false);
    if (already) {
      return NextResponse.json({ ok: true, already: true });
    }

    // 5) Finn email
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { data: userData } = await supabase.auth.getUser();
    const email = userData?.user?.email ?? "unknown";
    const nowIso = new Date().toISOString();

    // 6) Først: sett acknowledged (MÅ lykkes)
    {
      const r = await airtablePatchAlertRaw(decodedAlertId, { acknowledged: true });
      if (!r.ok) {
        throw new Error(`Airtable ack error (${r.status}): ${r.text}`);
      }
    }

    // 7) Så: prøv å sette acknowledged_at / ack_at / ack_time / acked_at
    {
      const timeCandidates = ["acknowledged_at", "ack_time", "ack_at", "acked_at"];
      for (const fieldName of timeCandidates) {
        const r = await airtablePatchAlertRaw(decodedAlertId, { [fieldName]: nowIso });
        if (r.ok) break;
        if (!isUnknownField422(r.status, r.text)) {
          throw new Error(`Airtable ack time error (${r.status}): ${r.text}`);
        }
      }
    }

    // 8) Så: prøv å sette “hvem ack’et”
    {
      const byCandidates = ["ack_by", "acknowledged_by", "ack_by_email", "ack_email"];
      for (const fieldName of byCandidates) {
        const r = await airtablePatchAlertRaw(decodedAlertId, { [fieldName]: email });
        if (r.ok) break;
        if (!isUnknownField422(r.status, r.text)) {
          throw new Error(`Airtable ack by error (${r.status}): ${r.text}`);
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const msg = e?.message ?? "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}