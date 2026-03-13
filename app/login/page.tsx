"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { enableMobileInputScroll } from "@/lib/scrollInputIntoView";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setMsg(error.message);
        return;
      }

      router.push("/homes");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-[100svh] overflow-y-auto bg-gray-50 px-4 py-6 sm:p-6">
      <div className="mx-auto w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">Logg inn</h1>
        <p className="mt-1 text-sm text-gray-600">Bruk e-post og passord.</p>

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
              autoComplete="current-password"
              required
              minLength={6}
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            className="mt-2 rounded-xl bg-gray-900 px-3 py-2 text-sm text-white shadow-sm hover:bg-gray-800 disabled:opacity-60"
          >
            {loading ? "Logger inn…" : "Logg inn"}
          </button>

          <div className="text-sm text-gray-700">
            Har du ikke bruker?{" "}
            <a className="underline" href="/register">
              Registrer deg
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