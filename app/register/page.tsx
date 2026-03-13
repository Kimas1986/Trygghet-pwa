"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { enableMobileInputScroll } from "@/lib/scrollInputIntoView";

function cleanPhone(input: string) {
  return (input || "").replace(/\s+/g, "").replace(/[^\d+]/g, "");
}

export default function RegisterPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [productCode, setProductCode] = useState("");

  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    enableMobileInputScroll();
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setLoading(true);

    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          phone: cleanPhone(phone),
          product_code: productCode.trim(),
        }),
      });

      const j = await res.json().catch(() => ({}));

      if (!res.ok) {
        setMsg(j?.error || `Feil (${res.status})`);
        return;
      }

      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (signInErr) {
        setMsg(
          `Bruker opprettet, men innlogging feilet: ${signInErr.message}. Prøv å logge inn.`
        );
        setTimeout(() => router.push("/login"), 900);
        return;
      }

      router.replace("/homes");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-[100svh] overflow-y-auto bg-gray-50 px-4 py-6 sm:p-6">
      <div className="mx-auto w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">
          Opprett admin og koble boks
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          Du må ha produktkoden fra boksen for å opprette et hjem.
        </p>

        <form onSubmit={onSubmit} className="mt-4 grid gap-3">
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
              required
              minLength={6}
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm text-gray-700">Telefon (uten +47)</span>
            <input
              className="rounded-xl border border-gray-300 px-3 py-2 text-gray-900 outline-none focus:ring-2 focus:ring-gray-900/10"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="numeric"
              placeholder="f.eks. 95855519"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm text-gray-700">
              Produktkode (står på boksen)
            </span>
            <input
              className="rounded-xl border border-gray-300 px-3 py-2 font-mono text-gray-900 outline-none focus:ring-2 focus:ring-gray-900/10"
              value={productCode}
              onChange={(e) => setProductCode(e.target.value)}
              placeholder="f.eks. BOX-1234-ABCD"
              required
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            className="mt-2 rounded-xl bg-gray-900 px-3 py-2 text-sm text-white shadow-sm hover:bg-gray-800 disabled:opacity-60"
          >
            {loading ? "Oppretter…" : "Opprett og koble boks"}
          </button>

          <div className="text-sm text-gray-700">
            Har du allerede bruker?{" "}
            <a className="underline" href="/login">
              Logg inn
            </a>
          </div>

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