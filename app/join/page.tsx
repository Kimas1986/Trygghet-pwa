"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

function cleanPhone(input: string) {
  return (input || "").replace(/\s+/g, "").replace(/[^\d+]/g, "");
}

function JoinInner() {
  const router = useRouter();
  const sp = useSearchParams();

  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const codeFromUrl = (sp.get("code") || "").trim();
  const hasPrefilledCode = codeFromUrl.length > 0;

  useEffect(() => {
    const q = sp.get("code");
    if (q) setCode(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setLoading(true);

    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token || null;

      const res = await fetch("/api/join", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          code: code.trim(),
          phone: cleanPhone(phone),
          email: token ? null : email.trim(),
          password: token ? null : password,
        }),
      });

      const j = await res.json().catch(() => ({}));

      if (!res.ok) {
        setMsg(j?.error || `Feil (${res.status})`);
        return;
      }

      if (!token) {
        const { error: signInErr } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInErr) {
          setMsg(`Du ble lagt til, men innlogging feilet: ${signInErr.message}. Prøv å logge inn.`);
          setTimeout(() => router.push("/login"), 900);
          return;
        }
      }

      router.replace("/homes");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">Bli med via invitasjon</h1>
        <p className="mt-1 text-sm text-gray-600">
          Du har fått en invitasjon til et hus i Trygghet. Fyll inn opplysningene dine for å bli lagt til.
        </p>

        <form onSubmit={onSubmit} className="mt-4 grid gap-3">
          <label className="grid gap-1">
            <span className="text-sm text-gray-700">Invitasjonskode</span>
            <input
              className="rounded-xl border border-gray-300 px-3 py-2 font-mono text-gray-900 outline-none focus:ring-2 focus:ring-gray-900/10 disabled:bg-gray-50 disabled:text-gray-500"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              disabled={hasPrefilledCode}
            />
          </label>

          {hasPrefilledCode && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
              Invitasjonskoden er hentet fra linken du åpnet.
            </div>
          )}

          <label className="grid gap-1">
            <span className="text-sm text-gray-700">Telefonnummer</span>
            <input
              className="rounded-xl border border-gray-300 px-3 py-2 text-gray-900 outline-none focus:ring-2 focus:ring-gray-900/10"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="numeric"
              placeholder="f.eks. 95855519"
              required
            />
          </label>

          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
            Hvis du ikke er innlogget, oppretter vi en bruker nå.
          </div>

          <label className="grid gap-1">
            <span className="text-sm text-gray-700">E-post</span>
            <input
              className="rounded-xl border border-gray-300 px-3 py-2 text-gray-900 outline-none focus:ring-2 focus:ring-gray-900/10"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="email"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm text-gray-700">Passord</span>
            <input
              className="rounded-xl border border-gray-300 px-3 py-2 text-gray-900 outline-none focus:ring-2 focus:ring-gray-900/10"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete="new-password"
              minLength={6}
              required
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            className="mt-2 rounded-xl bg-gray-900 px-3 py-2 text-sm text-white shadow-sm hover:bg-gray-800 disabled:opacity-60"
          >
            {loading ? "Legger til…" : "Bli med"}
          </button>

          {msg && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {msg}
            </div>
          )}
        </form>
      </div>
    </main>
  );
}

export default function JoinPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-gray-50 p-6">
          <div className="mx-auto max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            Laster…
          </div>
        </main>
      }
    >
      <JoinInner />
    </Suspense>
  );
}