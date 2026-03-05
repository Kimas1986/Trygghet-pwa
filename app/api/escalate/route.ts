import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY!
const ALERTS_TABLE = process.env.AIRTABLE_ALERTS_TABLE!

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const CRON_SECRET = process.env.CRON_SECRET || ""
const MAKE_SMS_WEBHOOK = process.env.MAKE_SMS_WEBHOOK || ""
const MAKE_SMS_WEBHOOK_APIKEY = process.env.MAKE_SMS_WEBHOOK_APIKEY || ""

const SMS_AFTER_MINUTES = 1

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function uniqStrings(arr: string[]) {
  return Array.from(new Set(arr.filter(Boolean)))
}

// Normaliserer norske nummer til +47XXXXXXXX
// Støtter input som:
// - 12345678
// - +4712345678
// - 004712345678
// - 47 12 34 56 78
function normalizeNorwegianPhone(input: string | null | undefined): string | null {
  if (!input) return null

  // Fjern mellomrom og alt som ikke er tall eller +
  let phone = String(input).trim().replace(/[^0-9+]/g, "")

  // 00 -> +
  if (phone.startsWith("00")) {
    phone = "+" + phone.substring(2)
  }

  // 47XXXXXXXX -> +47XXXXXXXX
  if (/^47[0-9]{8}$/.test(phone)) {
    phone = "+" + phone
  }

  // 8 siffer -> +47 + 8 siffer
  if (/^[0-9]{8}$/.test(phone)) {
    phone = "+47" + phone
  }

  // Godta kun +47 + 8 siffer
  if (/^\+47[0-9]{8}$/.test(phone)) {
    return phone
  }

  return null
}

export async function GET(req: Request) {
  try {
    // ✅ CRON_SECRET (header eller query)
    const urlObj = new URL(req.url)
    const secretFromQuery = urlObj.searchParams.get("secret") || ""
    const secretFromHeader = req.headers.get("x-cron-secret") || ""

    if (!CRON_SECRET) {
      return NextResponse.json(
        { error: "CRON_SECRET is not configured" },
        { status: 500 }
      )
    }

    if (secretFromHeader !== CRON_SECRET && secretFromQuery !== CRON_SECRET) {
      return unauthorized()
    }

    if (!MAKE_SMS_WEBHOOK) {
      return NextResponse.json(
        { error: "MAKE_SMS_WEBHOOK is not configured" },
        { status: 500 }
      )
    }

    if (!MAKE_SMS_WEBHOOK_APIKEY) {
      return NextResponse.json(
        { error: "MAKE_SMS_WEBHOOK_APIKEY is not configured" },
        { status: 500 }
      )
    }

    // Supabase admin client
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })

    // Airtable filter: ikke ack, ikke eskalert, eldre enn 60 min
    const filterByFormula = `AND(
      NOT({acknowledged}),
      NOT({escalation_sent}),
      DATETIME_DIFF(NOW(), CREATED_TIME(), 'minutes') >= ${SMS_AFTER_MINUTES}
    )`

    const airtableUrl =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
        ALERTS_TABLE
      )}?filterByFormula=${encodeURIComponent(filterByFormula)}`

    const res = await fetch(airtableUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json(
        { error: "Airtable fetch failed", details: text },
        { status: 500 }
      )
    }

    const data = await res.json()
    const records: any[] = data.records ?? []

    let sms_sent = 0
    let skipped_no_phones = 0
    let make_failed = 0

    for (const record of records) {
      const alertId = record.id
      const homeId: string | null = record.fields?.home_id || null

      if (!homeId) continue

      // 1) Finn alle user_id som er medlem av home
      const { data: members, error: memErr } = await admin
        .from("memberships")
        .select("user_id")
        .eq("home_id", homeId)

      if (memErr) {
        console.error("Membership lookup failed:", memErr)
        continue
      }

      const userIds = uniqStrings((members ?? []).map((m: any) => m.user_id))

      if (userIds.length === 0) {
        skipped_no_phones++
        continue
      }

      // 2) Hent telefoner fra profiles
      const { data: profiles, error: profErr } = await admin
        .from("profiles")
        .select("user_id, phone")
        .in("user_id", userIds)

      if (profErr) {
        console.error("Profiles lookup failed:", profErr)
        continue
      }

      // 3) Normaliser til +47XXXXXXXX og fjern duplikater
      const phones = uniqStrings(
        (profiles ?? [])
          .map((p: any) => normalizeNorwegianPhone(p?.phone))
          .filter((p: string | null) => !!p) as string[]
      )

      if (phones.length === 0) {
        skipped_no_phones++
        continue
      }

      // 4) Send til Make webhook (Make tar SMS)
      const hookRes = await fetch(MAKE_SMS_WEBHOOK, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-make-apikey": MAKE_SMS_WEBHOOK_APIKEY,
        },
        body: JSON.stringify({
          home_id: homeId,
          alert_id: alertId,
          phones,
          message: `TRYGGHET: Alarm for ${homeId} er ikke kvittert etter 60 minutter. Åpne appen og bekreft at du følger opp.`,
        }),
      })

      if (!hookRes.ok) {
        const t = await hookRes.text()
        console.error("Make webhook failed:", t)
        make_failed++
        continue
      }

      // 5) Marker escalation_sent=true (hindrer dobbel SMS)
      const patchRes = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
          ALERTS_TABLE
        )}/${alertId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${AIRTABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            fields: { escalation_sent: true },
          }),
        }
      )

      if (patchRes.ok) sms_sent++
    }

    return NextResponse.json({
      ok: true,
      sms_sent,
      skipped_no_phones,
      make_failed,
    })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: "Escalation failed" }, { status: 500 })
  }
}
