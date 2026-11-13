import { ImageResponse } from "next/og";

export const alt = "Necessa — medical-necessity intelligence for prior authorization";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const rows: { label: string; state: "met" | "gap" | "met2" }[] = [
  { label: "At least 6 weeks of conservative therapy documented", state: "met" },
  { label: "Imaging within 60 days of request", state: "met2" },
  { label: "Functional limitation score recorded", state: "gap" },
];

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#0a0b0d",
          backgroundImage:
            "radial-gradient(circle at 85% 10%, rgba(125,135,255,0.28), transparent 45%), radial-gradient(circle at 10% 100%, rgba(31,181,204,0.16), transparent 40%)",
          color: "#ecedef",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 18,
              background: "linear-gradient(135deg, #4d5af0, #3340c4)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="44" height="44" viewBox="0 0 32 32" fill="none">
              <path
                d="M9 23V9.5l7.6 9.8L24 8.5"
                stroke="#fff"
                strokeWidth="3.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: -1.5 }}>necessa</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 64, lineHeight: 1.05, letterSpacing: -2, maxWidth: 900 }}>
            Know what the payer will ask — before they ask.
          </div>
          <div style={{ fontSize: 26, color: "#a3a9b2", maxWidth: 860 }}>
            Criterion-by-criterion medical-necessity checks with citations to policy and chart.
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((r) => (
            <div
              key={r.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                fontSize: 22,
                color: "#c9cdd3",
              }}
            >
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  background: r.state === "gap" ? "#f0a53a" : "#3cc48c",
                }}
              />
              {r.label}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
