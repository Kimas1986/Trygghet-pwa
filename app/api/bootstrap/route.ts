import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID!;
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY!;
const HOMES_TABLE = process.env.AIRTABLE_HOMES_TABLE || "Homes";

function requireBearer(req: Request) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer (.+)$/);
  const token = m?.[1];
  if (!token) throw new Error("Missing Authorization Bearer token");
  return token;
}

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
  return (j.records ?? []) as Array<{ id: string; fields: any }>;
}

async function airtableUpsertHome(home_id: string) {
  const existing = await airtableFindByFormula(
    HOMES_TABLE,
    `{home_id}="${home_id.replace(/"/g, '\\"')}"`,
    1
  );

  const nowIso = new Date().toISOString();
  const fields: any = {
    home_id,
  };

  if (existing.length) {
    // Minimal patch: ikke rør state her
    const recordId = existing[0].id;
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(HOMES_TABLE)}/${recordId}`;
    const res = await airtableFetch(url, {
      method: "PATCH",
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Airtable Homes PATCH failed: ${t}`);
    }
    return { created: false };
  }

  // Create once
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(HOMES_TABLE)}`;
  const res = await airtableFetch(url, {
    method: "POST",
    body: JSON.stringify({
      records: [
        {
          fields: {
            ...fields,
            state: "green",
            last_seen: nowIso,
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Airtable Homes CREATE failed: ${t}`);
  }

  return { created: true };
}

export async function POST(req: Request) {
  try {
    const token = requireBearer(req);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: memberships, error } = await supabase
      .from("memberships")
      .select("home_id");

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const ids = (memberships ?? [])
      .map((m: any) => String(m.home_id ?? "").trim())
      .filter(Boolean);

    let created = 0;
    for (const home_id of ids) {
      const r = await airtableUpsertHome(home_id);
      if (r.created) created++;
    }

    return NextResponse.json({ ok: true, homes: ids.length, created });
  } catch (e: any) {
    const msg = e?.message ?? "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}