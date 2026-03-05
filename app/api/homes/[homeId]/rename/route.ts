import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY!;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;
const AIRTABLE_HOMES_TABLE = process.env.AIRTABLE_HOMES_TABLE || "Homes";

function json(status: number, data: any) {
  return NextResponse.json(data, { status });
}

function requireBearer(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  const token = match?.[1];
  if (!token) throw new Error("Missing Authorization Bearer token");
  return token;
}

function norm(s: string) {
  return String(s || "").trim();
}

async function airtableFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable error (${res.status}): ${text}`);
  }

  return res;
}

async function airtableFindHomeRecord(homeId: string) {
  const formula = `{home_id}="${homeId.replace(/"/g, '\\"')}"`;
  const url =
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_HOMES_TABLE)}` +
    `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

  const res = await airtableFetch(url, { method: "GET" });
  const j = await res.json();
  const rec = j.records?.[0];
  if (!rec) return null;

  return { id: rec.id as string, fields: (rec.fields ?? {}) as Record<string, any> };
}

function pickNameField(existingFields: Record<string, any>) {
  // Bruk et felt som faktisk finnes i tabellen for å unngå UNKNOWN_FIELD_NAME
  const candidates = ["name", "home_name", "house_name", "display_name", "title"];
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(existingFields, c)) return c;
  }
  // fallback: hvis ingen finnes, bruk "name" (du kan opprette feltet i Airtable)
  return "name";
}

async function airtablePatchRecord(recordId: string, fields: Record<string, any>) {
  const url =
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_HOMES_TABLE)}/${recordId}`;

  await airtableFetch(url, {
    method: "PATCH",
    body: JSON.stringify({ fields }),
  });
}

// ✅ Next.js 15: context.params er en Promise i typed route handlers
type Ctx = { params: Promise<{ homeId: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const token = requireBearer(req);
    const { homeId } = await ctx.params;

    const body = await req.json().catch(() => ({}));
    const newName = norm(body?.name);

    if (!newName || newName.length < 2) {
      return json(400, { error: "Ugyldig navn (minst 2 tegn)." });
    }
    if (newName.length > 60) {
      return json(400, { error: "Navnet er for langt (maks 60 tegn)." });
    }

    // 1) Verifiser at bruker er admin på dette hjemmet
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: membership, error: mErr } = await supabase
      .from("memberships")
      .select("role, home_id")
      .eq("home_id", homeId)
      .maybeSingle();

    if (mErr) return json(500, { error: mErr.message });

    const role = String(membership?.role ?? "").toLowerCase();
    if (role !== "admin") {
      return json(403, { error: "Forbidden (admin only)" });
    }

    // 2) Finn Airtable-record og oppdater husnavn
    const rec = await airtableFindHomeRecord(homeId);
    if (!rec) {
      return json(404, { error: `Fant ikke hjemmet i Airtable (home_id=${homeId}).` });
    }

    const fieldName = pickNameField(rec.fields);
    await airtablePatchRecord(rec.id, { [fieldName]: newName });

    return json(200, { ok: true, home_id: homeId, field: fieldName, name: newName });
  } catch (e: any) {
    const msg = e?.message ?? "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return json(status, { error: msg });
  }
}