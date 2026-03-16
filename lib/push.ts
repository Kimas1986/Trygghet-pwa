import { supabase } from "@/lib/supabaseClient";

export function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");

  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export async function ensurePushSubscription(homeId?: string) {
  if (typeof window === "undefined") return { ok: false, reason: "no-window" as const };
  if (!("serviceWorker" in navigator)) return { ok: false, reason: "no-sw" as const };
  if (!("PushManager" in window)) return { ok: false, reason: "no-push" as const };

  // Må ha session (for Bearer token)
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { ok: false, reason: "no-session" as const };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "denied" as const };

  const reg = await navigator.serviceWorker.register("/push-sw.js", { scope: "/" });

  const existing = await reg.pushManager.getSubscription();

  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
  if (!vapidPublicKey) return { ok: false, reason: "missing-vapid-public" as const };

  const subscription =
    existing ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));

  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      subscription,
      home_id: homeId ?? null,
      user_agent: navigator.userAgent,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, reason: `api-failed:${res.status}:${text}` as const };
  }

  return { ok: true as const };
}
