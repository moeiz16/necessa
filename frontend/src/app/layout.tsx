import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"], display: "swap" });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], display: "swap" });
const instrument = Instrument_Serif({ variable: "--font-instrument", subsets: ["latin"], weight: "400", style: ["normal", "italic"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: { default: "Necessa — Medical-necessity intelligence", template: "%s · Necessa" },
  description:
    "Necessa checks a patient's chart against the exact, version-correct coverage criteria of the applicable payer policy — criterion by criterion, with citations — and drafts prior-authorization and appeal letters for human review.",
  applicationName: "Necessa",
  keywords: ["prior authorization", "medical necessity", "LCD", "NCD", "RAG", "denial appeals", "revenue cycle"],
  openGraph: { type: "website", siteName: "Necessa", title: "Necessa — Medical-necessity intelligence" },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f8f6" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0b0d" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geist.variable} ${geistMono.variable} ${instrument.variable} min-h-dvh antialiased`}>
        <a href="#main" className="sr-only z-[100] rounded-md bg-surface px-3 py-2 text-sm shadow-e2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
