import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const next = url.searchParams.get("next") || "/homes";

    if (!code) {
      return NextResponse.redirect(new URL("/", req.url));
    }

    // Server-side exchange. We can't persist cookies here without auth-helpers,
    // but exchange is still useful and will validate the link.
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: { persistSession: false },
    });

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(new URL("/?err=auth_callback_failed", req.url));
    }

    // User will still need normal login if session isn't persisted by cookies.
    // In practice for your flow, redirecting to / is fine too.
    return NextResponse.redirect(new URL(next, req.url));
  } catch {
    return NextResponse.redirect(new URL("/?err=auth_callback_exception", req.url));
  }
}
