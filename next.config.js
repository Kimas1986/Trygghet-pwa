const withPWA = require("next-pwa")({
  dest: "public",
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === "development",

  // ✅ Viktig fix for Next App Router / Vercel
  buildExcludes: [
    /app-build-manifest\.json$/,
  ],
});

const nextConfig = {
  reactStrictMode: true,
};

module.exports = withPWA(nextConfig);