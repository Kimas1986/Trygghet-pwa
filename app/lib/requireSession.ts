import { supabase } from "@/lib/supabaseClient";
import type { Session } from "@supabase/supabase-js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Robust dev helper: retry a few times before considering user logged out
export async function requireSession(retries = 3): Promise<Session | null> {
  for (let i = 0; i <= retries; i++) {
    const { data, error } = await supabase.auth.getSession();

    const s = data?.session ?? null;
    if (s) return s;

    // If there is an error, still retry (ngrok/dev reload can transiently fail)
    if (i < retries) await sleep(350);
    else {
      // last try
      if (error) return null;
    }
  }
  return null;
}
