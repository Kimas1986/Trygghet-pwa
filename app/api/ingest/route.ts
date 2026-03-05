import { NextResponse } from "next/server";

const INGEST_SECRET = process.env.INGEST_SECRET || "";

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID!;
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY!;
const PRODUCTS = "Products";
const HOMES = process.env.AIRTABLE_HOMES_TABLE || "Homes";

function randomHomeId() {
  return "HUS_" + Math.random().toString(16).slice(2, 8).toUpperCase();
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

async function findOrCreateHomeIdForProduct(product_code: string) {
  const recs = await airtableFindByFormula(
    PRODUCTS,
    `{product_code}="${product_code.replace(/"/g, '\\"')}"`,
    1
  );
  if (recs.length) {
    const hid = String(recs[0].fields?.home_id ?? "").trim();
    if (hid) return hid;
  }

  const home_id = randomHomeId();
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(PRODUCTS)}`;
  const res = await airtableFetch(url, {
    method: "POST",
    body: JSON.stringify({
      records: [
        {
          fields: {
            product_code,
            home_id,
            activated: true,
            activated_at: new Date().toISOString(),
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Airtable Products create failed: ${t}`);
  }

  return home_id;
}

async function upsertHomeByHomeId(home_id: string, fields: any) {
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
  } else {
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
}

function parseIsoOrNull(v: any): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export async function POST(req: Request) {
  try {
    const urlObj = new URL(req.url);
    const secretQuery = urlObj.searchParams.get("secret") || "";
    const secretHeader = req.headers.get("x-ingest-secret") || "";
    if (INGEST_SECRET && secretQuery !== INGEST_SECRET && secretHeader !== INGEST_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({} as any));

    const product_code = String(body.product_code ?? "").trim().toUpperCase();
    const home_id_input = String(body.home_id ?? "").trim();

    const motionBool = body.motion === true;
    const door_open = body.door_open === true;
    const heartbeat = body.heartbeat === true;

    if (!home_id_input && !product_code) {
      return NextResponse.json({ error: "Missing home_id or product_code" }, { status: 400 });
    }

    const home_id = home_id_input || (await findOrCreateHomeIdForProduct(product_code));

    // ✅ Støtt både *_at og uten suffix
    const motionIso =
      parseIsoOrNull(body.last_motion_at) ??
      parseIsoOrNull(body.last_motion) ??
      null;

    const seenIso =
      parseIsoOrNull(body.last_seen_at) ??
      parseIsoOrNull(body.last_seen) ??
      null;

    const nowIso = new Date().toISOString();

    const fields: any = {};

    // ✅ last_seen: bruk payload hvis gyldig, ellers nå
    fields.last_seen = seenIso ?? nowIso;

    // door_open => away + grønn
    if (door_open) {
      fields.mode = "away";
      fields.mode_updated_at = nowIso;
      fields.state = "green";
    }

    // ✅ motion: enten bool eller eksplisitt timestamp
    if (motionBool || motionIso) {
      fields.last_motion = motionIso ?? nowIso;
      fields.mode = "home";
      fields.mode_updated_at = nowIso;
      fields.state = "green";
    }

    // heartbeat: kun last_seen, men hvis state mangler kan vi sette grønn (MVP)
    if (heartbeat && !motionBool && !motionIso && !door_open) {
      const existing = await airtableFindByFormula(
        HOMES,
        `{home_id}="${home_id.replace(/"/g, '\\"')}"`,
        1
      );

      const curState = String(existing?.[0]?.fields?.state ?? "").trim().toLowerCase();
      if (!curState) {
        fields.state = "green";
      }
    }

    const result = await upsertHomeByHomeId(home_id, fields);

    return NextResponse.json({
      ok: true,
      home_id,
      wrote: fields, // ✅ nyttig for debugging
      upsert: result,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}