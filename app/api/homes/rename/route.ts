import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY!;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;
const AIRTABLE_HOMES_TABLE = process.env.AIRTABLE_HOMES_TABLE || "Homes";

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

async function airtablePatch(tableName: string, recordId: string, fields: Record<string, any>) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
    tableName
  )}/${encodeURIComponent(recordId)}`;

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

export async function POST(req: Request) {
  try {
    const accessToken = requireBearer(req);

    const body = await req.json().catch(() => ({}));
    const home_id = String(body?.home_id ?? "").trim();
    const name = String(body?.name ?? "").trim();

    if (!home_id || !name) {
      return NextResponse.json({ error: "Missing home_id or name" }, { status: 400 });
    }

    // 1) Membership (alle medlemmer får lov til å endre navnet)
    const membership = await ensureMembership(accessToken, home_id);
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // 2) Finn Home-record i Airtable via home_id
    const formula = `{home_id}="${home_id.replace(/"/g, '\\"')}"`;
    const records = await airtableList(
      AIRTABLE_HOMES_TABLE,
      `filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`
    );

    const rec = records?.[0];
    if (!rec?.id) {
      return NextResponse.json({ error: "Home not found in Airtable" }, { status: 404 });
    }

    // 3) Patch: prøv flere feltnavn uten å kræsje hvis feltet ikke finnes
    const candidates = ["home_name", "name", "display_name", "title"];
    let updated = false;

    for (const fieldName of candidates) {
      const r = await airtablePatch(AIRTABLE_HOMES_TABLE, rec.id, { [fieldName]: name });
      if (r.ok) {
        updated = true;
        break;
      }
      if (!isUnknownField422(r.status, r.text)) {
        throw new Error(`Airtable rename error (${r.status}): ${r.text}`);
      }
    }

    if (!updated) {
      return NextResponse.json(
        { error: "Fant ingen navnefelt i Airtable (home_name/name/display_name/title)." },
        { status: 400 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const msg = e?.message ?? "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}