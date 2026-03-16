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
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Trygghet",
      },
    ],
    locale: "no_NO",
    type: "website",
  },

  twitter: {
    card: "summary_large_image",
    title: "Trygghet",
    description: "Status og varsler for hus du følger",
    images: ["/og-image.png"],
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