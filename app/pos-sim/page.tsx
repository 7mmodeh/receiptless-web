import React from "react";
import PosSimClient from "./PosSimClient";

export const dynamic = "force-dynamic";

function posSimEnabled(): boolean {
  const v = (process.env.POS_SIM_ENABLED ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

export default function PosSimPage() {
  if (!posSimEnabled()) {
    return (
      <main style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.h1}>Not available</h1>
          <p style={styles.p}>
            This demo page is disabled. Set <code>POS_SIM_ENABLED=true</code> to
            enable it.
          </p>
        </div>
      </main>
    );
  }

  return <PosSimClient />;
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    padding: "24px 16px",
    background: "#f6f7f9",
    display: "flex",
    justifyContent: "center",
  },
  card: {
    width: "100%",
    maxWidth: 720,
    background: "#ffffff",
    border: "1px solid rgba(0,0,0,0.08)",
    borderRadius: 14,
    padding: 18,
    boxShadow: "0 8px 24px rgba(0,0,0,0.06)",
  },
  h1: { margin: 0, fontSize: 22, lineHeight: 1.2, letterSpacing: -0.2 },
  p: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 1.55,
    color: "rgba(0,0,0,0.82)",
  },
};
