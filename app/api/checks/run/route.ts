import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendPushToHome } from "@/lib/server/push";
import {
  evaluateHomeState,
  resolveHomePatchFromEvaluatedState,
  shouldCreateRedAlert,
  shouldEscalateOpenAlert,
  isRedWindowNow,
} from "@/lib/server/state-engine";

const CRON_SECRET = process.env.CRON_SECRET || "";

const MAKE_SMS_WEBHOOK = process.env.MAKE_SMS_WEBHOOK || "";
const MAKE_SMS_WEBHOOK_APIKEY = process.env.MAKE_SMS_WEBHOOK_APIKEY || "";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const GREY_THRESHOLD_MIN = Number(process.env.GREY_THRESHOLD_MINUTES || 90);
const RED_THRESHOLD_HOURS = Number(process.env.RED_THRESHOLD_HOURS || 6);
const SMS_ESCALATION_MIN = Number(process.env.SMS_ESCALATION_MINUTES || 30);

type HomeRow = {
  id: string;
  home_id: string;
  home_name: string | null;
  state: string | null;
  last_seen: string | null;
  last_motion: string | null;
  mode: string | null;
  mode_updated_at: string | null;
  battery_low: boolean | null;
  system_ok: boolean | null;
  last_alert_window: string | null;
  last_alert_time: string | null;
};

type AlertRow = {
  id: string;
  alert_id: string | null;
  home_id: string;
  type: string | null;
  alert_window: string | null;
  triggered_at: string | null;
  acknowledged: boolean | null;
  acknowledged_at: string | null;
  ack_by: string | null;
  resolved_at: string | null;
  escalation_sent: boolean | null;
};

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status });
}

function getAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase env mangler");
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

async function getSmsRecipientsForHome(homeId: string): Promise<string[]> {
  const admin = getAdminClient();

  const { data, error } = await admin
    .from("contact_methods")
    .select("phone_e164,sms_enabled")
    .eq("home_id", homeId);

  if (error) {
    throw new Error(`Supabase contact_methods error: ${error.message}`);
  }

  const to = (data ?? [])
    .filter((r: { sms_enabled?: boolean | null }) => (r.sms_enabled ?? true) === true)
    .map((r: { phone_e164?: string | null }) => String(r.phone_e164 ?? "").trim())
    .filter((p: string) => p.startsWith("+") && p.length >= 9);

  return Array.from(new Set(to));
}

async function sendSmsViaMake(homeId: string, to: string[], message: string) {
  if (!MAKE_SMS_WEBHOOK) {
    throw new Error("MAKE_SMS_WEBHOOK is not configured");
  }

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

async function getOpenAlertForHome(homeId: string): Promise<AlertRow | null> {
  const admin = getAdminClient();

  const { data, error } = await admin
    .from("alerts")
    .select(
      "id, alert_id, home_id, type, alert_window, triggered_at, acknowledged, acknowledged_at, ack_by, resolved_at, escalation_sent"
    )
    .eq("home_id", homeId)
    .eq("acknowledged", false)
    .is("acknowledged_at", null)
    .is("resolved_at", null)
    .order("triggered_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase open alert lookup failed: ${error.message}`);
  }

  return (data as AlertRow | null) ?? null;
}

async function createAlertForHome(homeId: string, windowKey: string, nowIso: string) {
  const admin = getAdminClient();

  const { error } = await admin.from("alerts").insert({
    home_id: homeId,
    type: "red_inactivity",
    alert_window: windowKey,
    triggered_at: nowIso,
    acknowledged: false,
    escalation_sent: false,
  });

  if (error) {
    throw new Error(`Supabase create alert failed: ${error.message}`);
  }
}

async function updateHome(homeId: string, fields: Record<string, unknown>) {
  const admin = getAdminClient();

  const { error } = await admin.from("homes").update(fields).eq("home_id", homeId);

  if (error) {
    throw new Error(`Supabase homes update failed: ${error.message}`);
  }
}

async function setAlertEscalationSent(alertDbId: string) {
  const admin = getAdminClient();

  const { error } = await admin
    .from("alerts")
    .update({
      escalation_sent: true,
    })
    .eq("id", alertDbId);

  if (error) {
    throw new Error(`Supabase alert escalation update failed: ${error.message}`);
  }
}

export async function GET(req: Request) {
  return POST(req);
}

export async function POST(req: Request) {
  try {
    if (!CRON_SECRET) {
      return json(500, { error: "CRON_SECRET is not configured" });
    }

    const urlObj = new URL(req.url);
    const secretHeader = req.headers.get("x-cron-secret") || "";
    const secretQuery = urlObj.searchParams.get("secret") || "";

    if (secretHeader !== CRON_SECRET && secretQuery !== CRON_SECRET) {
      return json(401, { error: "Unauthorized" });
    }

    const windowParamRaw = urlObj.searchParams.get("window");
    const explicitWindow =
      windowParamRaw === "12" || windowParamRaw === "18" || windowParamRaw === "23"
        ? windowParamRaw
        : null;

    const forceRed = urlObj.searchParams.get("force_red") === "1";
    const doGrey = urlObj.searchParams.get("grey") !== "0";

    const now = new Date();
    const redEnabled = forceRed || Boolean(explicitWindow) || isRedWindowNow(now);

    const admin = getAdminClient();

    const { data: homesData, error: homesError } = await admin
      .from("homes")
      .select(
        "id, home_id, home_name, state, last_seen, last_motion, mode, mode_updated_at, battery_low, system_ok, last_alert_window, last_alert_time"
      );

    if (homesError) {
      throw new Error(`Supabase homes fetch failed: ${homesError.message}`);
    }

    const homes = (homesData ?? []) as HomeRow[];

    let greySet = 0;
    let redSet = 0;
    let greenSet = 0;
    let alertsCreated = 0;
    let pushSent = 0;
    let smsSent = 0;
    let smsSkippedNoRecipients = 0;

    const warnings: string[] = [];

    for (const rec of homes) {
      const homeId = String(rec.home_id || "").trim();
      if (!homeId) continue;

      try {
        const evaluated = evaluateHomeState(
          {
            home_id: rec.home_id,
            state: rec.state,
            mode: rec.mode,
            last_seen: rec.last_seen,
            last_motion: rec.last_motion,
            last_alert_window: rec.last_alert_window,
            last_alert_time: rec.last_alert_time,
          },
          {
            greyThresholdMinutes: GREY_THRESHOLD_MIN,
            redThresholdHours: RED_THRESHOLD_HOURS,
          },
          {
            now,
            redEnabled,
            doGrey,
          }
        );

        const currentState = String(rec.state ?? "").trim().toLowerCase();
        const statePatch = resolveHomePatchFromEvaluatedState(currentState, evaluated);
        const fieldsToUpdate: Record<string, unknown> = { ...statePatch };
        let willPatch = Object.keys(fieldsToUpdate).length > 0;

        if (evaluated.nextState === "grey" && currentState !== "grey") {
          greySet++;
        }

        if (evaluated.nextState === "red" && currentState !== "red") {
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

        if (evaluated.nextState === "green" && currentState !== "green") {
          greenSet++;
        }

        const alertDecision = shouldCreateRedAlert({
          home: {
            home_id: rec.home_id,
            state: rec.state,
            mode: rec.mode,
            last_seen: rec.last_seen,
            last_motion: rec.last_motion,
            last_alert_window: rec.last_alert_window,
            last_alert_time: rec.last_alert_time,
          },
          now,
          explicitWindow,
          redEnabled,
          nextState: evaluated.nextState,
        });

        if (alertDecision.shouldCreate) {
          const nowIso = now.toISOString();

          await createAlertForHome(homeId, alertDecision.windowKey, nowIso);
          alertsCreated++;

          fieldsToUpdate.last_alert_window = alertDecision.windowKey;
          fieldsToUpdate.last_alert_time = nowIso;
          willPatch = true;
        }

        try {
          const openAlert = await getOpenAlertForHome(homeId);

          const shouldEscalate = shouldEscalateOpenAlert({
            triggered_at: openAlert?.triggered_at ?? null,
            escalation_sent: openAlert?.escalation_sent ?? false,
            acknowledged: openAlert?.acknowledged ?? false,
            acknowledged_at: openAlert?.acknowledged_at ?? null,
            resolved_at: openAlert?.resolved_at ?? null,
            now,
            smsEscalationMinutes: SMS_ESCALATION_MIN,
          });

          if (openAlert && shouldEscalate) {
            const recipients = await getSmsRecipientsForHome(homeId);

            if (recipients.length === 0) {
              smsSkippedNoRecipients++;
            } else {
              const msg = `TRYGGHET: Ingen bevegelse på ${homeId} i over ${RED_THRESHOLD_HOURS} timer. Sjekk appen.`;
              await sendSmsViaMake(homeId, recipients, msg);
              await setAlertEscalationSent(openAlert.id);
              smsSent++;
            }
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "unknown";
          warnings.push(`sms escalation failed for ${homeId}: ${msg}`);
        }

        if (willPatch) {
          await updateHome(homeId, fieldsToUpdate);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "unknown";
        warnings.push(`home ${homeId} failed: ${msg}`);
      }
    }

    return json(200, {
      ok: true,
      red_enabled: redEnabled,
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
      note: "checks now use state-engine + Supabase homes + alerts",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return json(500, { error: msg });
  }
}