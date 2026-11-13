import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"], display: "swap" });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: { default: "Necessa — Prior authorization, ready the first time", template: "%s · Necessa" },
  description:
    "Necessa checks each case against the payer's policy before you submit, shows exactly what is missing, and prepares the request or appeal letter for your clinician to review and sign.",
  applicationName: "Necessa",
  keywords: ["prior authorization", "medical necessity", "denial appeals", "revenue cycle", "payer policy", "HIPAA-aligned"],
  openGraph: { type: "website", siteName: "Necessa", title: "Necessa — Prior authorization, ready the first time" },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0c" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geist.variable} ${geistMono.variable} min-h-dvh antialiased`}>
        <a href="#main" className="sr-only z-[100] rounded-md bg-surface px-3 py-2 text-sm shadow-e2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
