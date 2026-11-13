"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#0a0b0d", color: "#ecedef", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0 }}>
        <div style={{ textAlign: "center", maxWidth: 420, padding: 24 }}>
          <svg width="40" height="40" viewBox="0 0 32 32" fill="none" aria-hidden>
            <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="#4d5af0" />
            <path d="M9 23V9.5l7.6 9.8L24 8.5" stroke="#fff" strokeWidth="3.1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h1 style={{ fontSize: 20, marginTop: 20 }}>Necessa hit an unexpected error</h1>
          <p style={{ color: "#a3a9b2", fontSize: 14 }}>Please reload. Reference: {error.digest ?? "n/a"}</p>
          <button onClick={reset} style={{ marginTop: 16, background: "#7d87ff", color: "#0a0b1a", border: 0, borderRadius: 8, padding: "10px 16px", fontWeight: 600, cursor: "pointer" }}>
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
