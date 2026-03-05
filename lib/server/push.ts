import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function initWebPush() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;

  if (!pub || !priv || !subject) {
    throw new Error("Missing VAPID env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT)");
  }
  webpush.setVapidDetails(subject, pub, priv);
}

function adminSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing Supabase admin env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

export async function sendPushToHome(homeId: string, payload: any) {
  initWebPush();
  const admin = adminSupabase();

  const { data: members, error: mErr } = await admin
    .from("memberships")
    .select("user_id")
    .eq("home_id", homeId);

  if (mErr) throw new Error(mErr.message);

  const userIds = (members ?? []).map((m: any) => m.user_id);
  if (userIds.length === 0) return { ok: true, sent: 0, cleaned: 0 };

  const { data: subs, error: sErr } = await admin
    .from("push_subscriptions")
    .select("endpoint,p256dh,auth,user_id,home_id")
    .in("user_id", userIds)
    .or(`home_id.is.null,home_id.eq.${homeId}`);

  if (sErr) throw new Error(sErr.message);

  let sent = 0;
  const deadEndpoints: string[] = [];

  await Promise.all(
    (subs ?? []).map(async (s: any) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth },
          } as any,
          JSON.stringify(payload)
        );
        sent++;
      } catch (e: any) {
        const status = e?.statusCode;
        if (status === 410 || status === 404) deadEndpoints.push(s.endpoint);
      }
    })
  );

  if (deadEndpoints.length) {
    await admin.from("push_subscriptions").delete().in("endpoint", deadEndpoints);
  }

  return { ok: true, sent, cleaned: deadEndpoints.length };
}