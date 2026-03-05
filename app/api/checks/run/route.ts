import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToHome } from "@/lib/server/push";

const CRON_SECRET = process.env.CRON_SECRET || "";

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY!;
const HOMES_TABLE = process.env.AIRTABLE_HOMES_TABLE || "Homes";
const ALERTS_TABLE = process.env.AIRTABLE_ALERTS_TABLE || "Alerts";

const MAKE_SMS_WEBHOOK = process.env.MAKE_SMS_WEBHOOK || "";
const MAKE_SMS_WEBHOOK_APIKEY = process.env.MAKE_SMS_WEBHOOK_APIKEY || "";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const GREY_THRESHOLD_MIN = Number(process.env.GREY_THRESHOLD_MINUTES || 90);
const RED_THRESHOLD_HOURS = Number(process.env.RED_THRESHOLD_HOURS || 6);
const SMS_ESCALATION_MIN = Number(process.env.SMS_ESCALATION_MINUTES || 30);

const RED_THRESHOLD_MS = RED_THRESHOLD_HOURS * 60 * 60 * 1000;
const GREY_THRESHOLD_MS = GREY_THRESHOLD_MIN * 60 * 1000;

type AirtableRecord<TFields = any> = { id: string; fields: TFields };

function json(status: number, data: any) {
  return NextResponse.json(data, { status });
}

function parseDateOrNull(v: any): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

function iso(d: Date) {
  return d.toISOString();
}

function normMode(v: any): "home" | "away" | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "away") return "away";
  if (s === "home") return "home";
  return null;
}

async function airtableFetch(url: string, init?: RequestInit) {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
}

async function airtableListAll(tableName: string): Promise<AirtableRecord[]> {
  const out: AirtableRecord[] = [];
  let offset: string | undefined;

  while (true) {
    const url =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}` +
      `?pageSize=100` +
      (offset ? `&offset=${encodeURIComponent(offset)}` : "");

    const res = await airtableFetch(url, { method: "GET" });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Airtable list failed (${tableName}): ${t}`);
    }
    const j = await res.json();
    out.push(...(j.records || []));
    offset = j.offset;
    if (!offset) break;
  }

  return out;
}

function pickNewestHomeRecordPerHomeId(records: AirtableRecord[]): AirtableRecord[] {
  const map = new Map<string, AirtableRecord>();

  for (const r of records) {
    const f: any = r.fields || {};
    const homeId = String(f.home_id || "").trim();
    if (!homeId) continue;

    const lastSeen = parseDateOrNull(f.last_seen)?.getTime() ?? 0;
    const lastMotion = parseDateOrNull(f.last_motion)?.getTime() ?? 0;
    const score = Math.max(lastSeen, lastMotion);

    const existing = map.get(homeId);
    if (!existing) {
      map.set(homeId, r);
      (r as any).__score = score;
      continue;
    }

    const exScore = (existing as any).__score ?? 0;
    if (score >= exScore) {
      map.set(homeId, r);
      (r as any).__score = score;
    }
  }

  return Array.from(map.values());
}

async function airtablePatchRecord(tableName: string, recordId: string, fields: any) {
  const url =
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}` + `/${recordId}`;

  const res = await airtableFetch(url, { method: "PATCH", body: JSON.stringify({ fields }) });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Airtable PATCH failed (${tableName}): ${t}`);
  }
}

async function airtableCreateAlert(fields: any) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(ALERTS_TABLE)}`;

  const res = await airtableFetch(url, {
    method: "POST",
    body: JSON.stringify({ records: [{ fields }] }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Airtable CREATE alert failed: ${t}`);
  }
}

function nowOsloHour(d: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const hh = parts.find((p) => p.type === "hour")?.value || "00";
  return Number(hh);
}

async function airtableFindOpenAlertForHome(homeId: string): Promise<AirtableRecord | null> {
  const formula = `AND({home_id}="${homeId.replace(/"/g, '\\"')}", {acknowledged}=FALSE())`;
  const url =
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(ALERTS_TABLE)}` +
    `?filterByFormula=${encodeURIComponent(formula)}` +
    `&sort[0][field]=triggered_at&sort[0][direction]=desc&maxRecords=1`;

  const res = await airtableFetch(url, { method: "GET" });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Airtable open alert lookup failed: ${t}`);
  }
  const j = await res.json();
  return j.records && j.records[0] ? j.records[0] : null;
}

async function getSmsRecipientsForHome(homeId: string): Promise<string[]> {
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data, error } = await admin
    .from("contact_methods")
    .select("phone_e164,sms_enabled")
    .eq("home_id", homeId);

  if (error) throw new Error(`Supabase contact_methods error: ${error.message}`);

  const to = (data ?? [])
    .filter((r: any) => (r.sms_enabled ?? true) === true)
    .map((r: any) => String(r.phone_e164 ?? "").trim())
    .filter((p: string) => p.startsWith("+") && p.length >= 9);

  return Array.from(new Set(to));
}

async function sendSmsViaMake(homeId: string, to: string[], message: string) {
  if (!MAKE_SMS_WEBHOOK) throw new Error("MAKE_SMS_WEBHOOK is not configured");

  const res = await fetch(MAKE_SMS_WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-make-apikey": MAKE_SMS_WEBHOOK_APIKEY,
    },
    body: JSON.stringify({
      home_id: homeId,
      kind: "sms_escalation_30m",
      to,
      message,
      ts: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Make SMS webhook failed (${res.status}): ${t}`);
  }
}

export async function GET(req: Request) {
  return POST(req);
}

export async function POST(req: Request) {
  try {
    if (!CRON_SECRET) return json(500, { error: "CRON_SECRET is not configured" });

    const urlObj = new URL(req.url);
    const secretHeader = req.headers.get("x-cron-secret") || "";
    const secretQuery = urlObj.searchParams.get("secret") || "";
    if (secretHeader !== CRON_SECRET && secretQuery !== CRON_SECRET) {
      return json(401, { error: "Unauthorized" });
    }

    const window = urlObj.searchParams.get("window");
    const doRedExplicit = window === "12" || window === "18" || window === "23";
    const forceRed = urlObj.searchParams.get("force_red") === "1";
    const doGrey = urlObj.searchParams.get("grey") !== "0";

    const now = new Date();
    const osloHour = nowOsloHour(now);

    const doRedAuto = !doRedExplicit && (osloHour === 12 || osloHour === 18 || osloHour === 23);
    const redEnabled = forceRed || doRedExplicit || doRedAuto;

    const allHomes = await airtableListAll(HOMES_TABLE);
    const homes = pickNewestHomeRecordPerHomeId(allHomes); // ✅ dedupe

    let greySet = 0,
      redSet = 0,
      greenSet = 0,
      alertsCreated = 0,
      pushSent = 0,
      smsSent = 0,
      smsSkippedNoRecipients = 0;

    const warnings: string[] = [];

    for (const rec of homes) {
      const f: any = rec.fields || {};
      const homeId = String(f.home_id || "").trim();
      if (!homeId) continue;

      try {
        const lastSeen = parseDateOrNull(f.last_seen);
        const lastMotion = parseDateOrNull(f.last_motion);
        const currentState = (f.state ? String(f.state) : "").toLowerCase();

        const mode = normMode(f.mode);
        const isAway = mode === "away";

        const offlineTooLong =
          doGrey && (!lastSeen || now.getTime() - lastSeen.getTime() > GREY_THRESHOLD_MS);

        // ✅ away = aldri red pga inactivity
        const inactivityTooLong =
          redEnabled &&
          !offlineTooLong &&
          !isAway &&
          (!lastMotion || now.getTime() - lastMotion.getTime() > RED_THRESHOLD_MS);

        const fieldsToUpdate: any = {};
        let willPatch = false;

        if (offlineTooLong) {
          if (currentState !== "grey") {
            fieldsToUpdate.state = "grey";
            willPatch = true;
            greySet++;
          }
        } else if (inactivityTooLong) {
          const becameRed = currentState !== "red";

          if (becameRed) {
            fieldsToUpdate.state = "red";
            willPatch = true;
            redSet++;

            try {
              await sendPushToHome(homeId, {
                title: "Trygghet: Ingen aktivitet",
                body: "Uvanlig lang tid uten bevegelse. Trykk for status.",
                url: `/homes/${encodeURIComponent(homeId)}`,
                home_id: homeId,
              });
              pushSent++;
            } catch {
              warnings.push(`push failed for ${homeId}`);
            }
          }

          const lastAlertWindow = f.last_alert_window ? String(f.last_alert_window) : "";
          const lastAlertTime = parseDateOrNull(f.last_alert_time);
          const windowKey = doRedExplicit ? String(window) : doRedAuto ? String(osloHour) : "red";

          const recentlyAlerted =
            lastAlertWindow === windowKey &&
            lastAlertTime &&
            now.getTime() - lastAlertTime.getTime() < 12 * 60 * 60 * 1000;

          if (!recentlyAlerted) {
            await airtableCreateAlert({
              home_id: homeId,
              type: "red_inactivity",
              window: windowKey,
              triggered_at: iso(now),
              acknowledged: false,
              escalation_sent: false,
            });
            alertsCreated++;

            fieldsToUpdate.last_alert_window = windowKey;
            fieldsToUpdate.last_alert_time = iso(now);
            willPatch = true;
          }

          // SMS eskalering
          try {
            const openAlert = await airtableFindOpenAlertForHome(homeId);
            const trig = parseDateOrNull(openAlert?.fields?.triggered_at);
            const escSent = Boolean(openAlert?.fields?.escalation_sent ?? false);

            if (openAlert && trig && !escSent) {
              const ageMin = (now.getTime() - trig.getTime()) / (60 * 1000);

              if (ageMin >= SMS_ESCALATION_MIN) {
                const recipients = await getSmsRecipientsForHome(homeId);

                if (recipients.length === 0) {
                  smsSkippedNoRecipients++;
                } else {
                  const msg = `TRYGGHET: Ingen bevegelse på ${homeId} i over ${RED_THRESHOLD_HOURS} timer. Sjekk appen.`;
                  await sendSmsViaMake(homeId, recipients, msg);

                  await airtablePatchRecord(ALERTS_TABLE, openAlert.id, {
                    escalation_sent: true,
                    escalation_sent_at: iso(now),
                  });

                  smsSent++;
                }
              }
            }
          } catch (e: any) {
            warnings.push(`sms escalation failed for ${homeId}: ${e?.message ?? "unknown"}`);
          }
        } else {
          if (currentState !== "green") {
            fieldsToUpdate.state = "green";
            willPatch = true;
            greenSet++;
          }
        }

        if (willPatch) {
          await airtablePatchRecord(HOMES_TABLE, rec.id, fieldsToUpdate);
        }
      } catch (e: any) {
        warnings.push(`home ${homeId} failed: ${e?.message ?? "unknown"}`);
        continue;
      }
    }

    return json(200, {
      ok: true,
      red_enabled: redEnabled,
      osloHour,
      greySet,
      redSet,
      greenSet,
      alertsCreated,
      pushSent,
      smsSent,
      smsSkippedNoRecipients,
      warnings,
      thresholds: {
        grey_minutes: GREY_THRESHOLD_MIN,
        red_hours: RED_THRESHOLD_HOURS,
        sms_escalation_minutes: SMS_ESCALATION_MIN,
      },
      note: "homes are deduped by home_id (newest last_seen/last_motion wins)",
    });
  } catch (e: any) {
    return json(500, { error: e?.message ?? "Unknown error" });
  }
}