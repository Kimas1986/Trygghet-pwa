import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status });
}

function requireBearer(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  const token = match?.[1];
  if (!token) throw new Error("Missing Authorization Bearer token");
  return token;
}

function norm(s: unknown) {
  return String(s ?? "").trim();
}

type Ctx = { params: Promise<{ homeId: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const token = requireBearer(req);
    const { homeId: rawHomeId } = await ctx.params;
    const homeId = norm(decodeURIComponent(rawHomeId));

    if (!homeId) {
      return json(400, { error: "Missing homeId" });
    }

    const body = await req.json().catch(() => ({}));
    const newName = norm((body as { name?: unknown })?.name);

    if (!newName || newName.length < 2) {
      return json(400, { error: "Ugyldig navn (minst 2 tegn)." });
    }

    if (newName.length > 60) {
      return json(400, { error: "Navnet er for langt (maks 60 tegn)." });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // Verifiser at bruker er admin på dette hjemmet
    const { data: membership, error: membershipError } = await supabase
      .from("memberships")
      .select("role, home_id")
      .eq("home_id", homeId)
      .maybeSingle();

    if (membershipError) {
      return json(500, { error: membershipError.message });
    }

    const role = String(membership?.role ?? "").toLowerCase();
    if (role !== "admin") {
      return json(403, { error: "Forbidden (admin only)" });
    }

    // Oppdater home_name i Supabase homes
    const { data: updatedHome, error: updateError } = await supabase
      .from("homes")
      .update({ home_name: newName })
      .eq("home_id", homeId)
      .select("home_id, home_name")
      .maybeSingle();

    if (updateError) {
      return json(500, { error: updateError.message });
    }

    if (!updatedHome) {
      return json(404, { error: `Fant ikke hjemmet i Supabase homes (home_id=${homeId}).` });
    }

    return json(200, {
      ok: true,
      home_id: updatedHome.home_id,
      name: updatedHome.home_name,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const status = msg.includes("Missing Authorization") ? 401 : 500;
    return json(status, { error: msg });
  }
}