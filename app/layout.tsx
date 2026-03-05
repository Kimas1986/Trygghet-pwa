import "./globals.css";

export const metadata = {
  title: "Trygghet",
  description: "Trygghet PWA",
  manifest: "/manifest.webmanifest",
  themeColor: "#111827",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="no">
      <body>{children}</body>
    </html>
  );
}
