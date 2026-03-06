import withPWAInit from "next-pwa";
import type { NextConfig } from "next";

const withPWA = withPWAInit({
  dest: "public",
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === "development",

  // ✅ Viktig fix for Next App Router / Vercel
  buildExcludes: [
    /app-build-manifest\.json$/,
  ],
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default withPWA(nextConfig);