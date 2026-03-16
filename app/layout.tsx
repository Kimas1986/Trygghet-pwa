import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Trygghet",
  description: "Status og varsler for hus du følger",

  metadataBase: new URL("https://trygghet.vercel.app"),

  manifest: "/manifest.webmanifest",

  themeColor: "#111827",

  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },

  openGraph: {
    title: "Trygghet",
    description: "Status og varsler for hus du følger",
    url: "https://trygghet.vercel.app",
    siteName: "Trygghet",
    images: ["/og-image"],
    locale: "no_NO",
    type: "website",
  },

  twitter: {
    card: "summary_large_image",
    title: "Trygghet",
    description: "Status og varsler for hus du følger",
    images: ["/og-image"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="no">
      <body>{children}</body>
    </html>
  );
}