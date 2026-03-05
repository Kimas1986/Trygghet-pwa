import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function GET() {
  // Supabase client-session cookie inneholder access token i appen,
  // men vi kan ikke dekode den trygt her uten supabase helper.
  // Derfor gjør vi en enklere løsning: fortell deg hva du skal hente i DevTools.
  return NextResponse.json({
    ok: false,
    howto:
      "Åpne nettleser DevTools → Application → Local Storage → finn 'sb-...-auth-token' og kopier access_token. Lim den inn i curl-kommandoen jeg ga deg.",
  });
}