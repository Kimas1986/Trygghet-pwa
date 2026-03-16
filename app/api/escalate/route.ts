import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const CRON_SECRET = process.env.CRON_SECRET || "";
const MAKE_SMS_WEBHOOK = process.env.MAKE_SMS_WEBHOOK || "";
const MAKE_SMS_WEBHOOK_APIKEY = process.env.MAKE_SMS_WEBHOOK_APIKEY || "";

// Beholdt lik eksisterende oppførsel i denne ruta
const SMS_AFTER_MINUTES = 1;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function uniqStrings(arr: string[]) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function parseDateOrNull(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

// Normaliserer norske nummer til +47XXXXXXXX
function normalizeNorwegianPhone(input: string | null | undefined): string | null {
  if (!input) return null;

  let phone = String(input).trim().replace(/[^0-9+]/g, "");

  if (phone.startsWith("00")) {
    phone = "+" + phone.substring(2);
  }

  if (/^47[0-9]{8}$/.test(phone)) {
    phone = "+" + phone;
  }

  if (/^[0-9]{8}$/.test(phone)) {
    phone = "+47" + phone;
  }

  if (/^\+47[0-9]{8}$/.test(phone)) {
    return phone;
  }

  return null;
}

export async function GET(req: Request) {
  try {
    const urlObj = new URL(req.url);
    const secretFromQuery = urlObj.searchParams.get("secret") || "";
    const secretFromHeader = req.headers.get("x-cron-secret") || "";

    if (!CRON_SECRET) {
      return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
    }

    if (secretFromHeader !== CRON_SECRET && secretFromQuery !== CRON_SECRET) {
      return unauthorized();
    }

    if (!MAKE_SMS_WEBHOOK) {
      return NextResponse.json({ error: "MAKE_SMS_WEBHOOK is not configured" }, { status: 500 });
    }

    if (!MAKE_SMS_WEBHOOK_APIKEY) {
      return NextResponse.json(
        { error: "MAKE_SMS_WEBHOOK_APIKEY is not configured" },
        { status: 500 }
      );
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const cutoffIso = new Date(Date.now() - SMS_AFTER_MINUTES * 60 * 1000).toISOString();

    // Hent åpne alerts som ikke allerede er eskalert og som er gamle nok
    const { data: alerts, error: alertsError } = await admin
      .from("alerts")
      .select("id, alert_id, home_id, triggered_at, acknowledged, acknowledged_at, resolved_at, escalation_sent")
      .eq("acknowledged", false)
      .is("acknowledged_at", null)
      .is("resolved_at", null)
      .eq("escalation_sent", false)
      .lte("triggered_at", cutoffIso);

    if (alertsError) {
      return NextResponse.json(
        { error: "Supabase alerts fetch failed", details: alertsError.message },
        { status: 500 }
      );
    }

    let sms_sent = 0;
    let skipped_no_phones = 0;
    let make_failed = 0;

    for (const alert of alerts ?? []) {
      const alertId = String(alert.id ?? "").trim();
      const homeId = String(alert.home_id ?? "").trim();
      const triggeredAt = parseDateOrNull(alert.triggered_at);

      if (!alertId || !homeId || !triggeredAt) {
        continue;
      }

      // Hent telefoner fra contact_methods for hjemmet
      const { data: contacts, error: contactErr } = await admin
        .from("contact_methods")
        .select("phone_e164, sms_enabled")
        .eq("home_id", homeId);

      if (contactErr) {
        console.error("contact_methods lookup failed:", contactErr);
        continue;
      }

      const phones = uniqStrings(
        (contacts ?? [])
          .filter((c: { sms_enabled?: boolean | null }) => (c.sms_enabled ?? true) === true)
          .map((c: { phone_e164?: string | null }) => normalizeNorwegianPhone(c.phone_e164))
          .filter((p: string | null): p is string => Boolean(p))
      );

      if (phones.length === 0) {
        skipped_no_phones++;
        continue;
      }

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
          message: `TRYGGHET: Alarm for ${homeId} er ikke kvittert etter ${SMS_AFTER_MINUTES} minutter. Åpne appen og bekreft at du følger opp.`,
        }),
      });

      if (!hookRes.ok) {
        const t = await hookRes.text();
        console.error("Make webhook failed:", t);
        make_failed++;
        continue;
      }

      const { error: patchError } = await admin
        .from("alerts")
        .update({ escalation_sent: true })
        .eq("id", alertId);

      if (patchError) {
        console.error("Supabase alert update failed:", patchError);
        continue;
      }

      sms_sent++;
    }

    return NextResponse.json({
      ok: true,
      sms_sent,
      skipped_no_phones,
      make_failed,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Escalation failed" }, { status: 500 });
  }
}
