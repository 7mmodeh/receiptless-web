// app/admin/sim/page.tsx
"use client";

import { useMemo } from "react";

const POS_SIM_ENABLED =
  (process.env.NEXT_PUBLIC_POS_SIM_ENABLED ?? "").toLowerCase() === "true" ||
  process.env.NEXT_PUBLIC_POS_SIM_ENABLED === "1";

type LinkCard = {
  title: string;
  href: string;
  description: string;
  badges?: string[];
};

function buildCustomerDisplayHint(sessionCode: string) {
  // Customer UI is typically mounted elsewhere (created per-session by the create-session function).
  // We cannot reliably hardcode the route here without inventing your internal routing.
  // So we provide a safe hint that matches how the system works today: start a session in a host,
  // then use the "Open Customer Display" link shown in that host UI.
  return `Start a demo session in a host (Web or Android). Then click “Open Customer Display” inside the host UI. Session code: ${sessionCode}`;
}

export default function PosSimHubPage() {
  const cards = useMemo<LinkCard[]>(
    () => [
      {
        title: "Web POS Host (A5)",
        href: "/admin/sim/web-pos",
        description:
          "Browser-based POS host simulator. Canonical state is pos_sim_sessions.snapshot_json; durable audit is pos_sim_events via RPC; SNAPSHOT_SYNC drives realtime UI.",
        badges: ["Host", "Web POS", "A5"],
      },
      {
        title: "Android POS Host (A6)",
        href: "/admin/sim/android-pos",
        description:
          "Android terminal POS host simulator UI. Same lifecycle architecture as Web POS (snapshot canonical, events durable, SNAPSHOT_SYNC realtime).",
        badges: ["Host", "Android POS", "A6"],
      },
    ],
    []
  );

  const doc = useMemo(() => {
    // One-page “POS Integration Kit v1” mapping (as requested).
    // Kept intentionally concise and vendor-facing. No backend changes required.
    return [
      "# POS Integration Kit v1 — Receiptless POS Simulator (One-Pager)",
      "",
      "## Scope",
      "This kit demonstrates a complete POS → Receiptless flow using two POS host modules:",
      "- **Web POS Host** (browser/web POS category)",
      "- **Android POS Host** (native Android terminal POS category)",
      "",
      "Both modules share the **same lifecycle architecture** and prove the system end-to-end.",
      "",
      "## Canonical State (Source of Truth)",
      "**Table:** `public.pos_sim_sessions`",
      "- **Column:** `snapshot_json`",
      "- This JSON is the canonical state for the active session and must be treated as the source of truth.",
      "",
      "## Durable Audit Trail (Immutable Timeline)",
      "**Table:** `public.pos_sim_events`",
      "- Events are written through SECURITY DEFINER RPC to ensure consistent insert semantics:",
      "  - `pos_sim_log_event(p_session_id, p_event_type, p_payload)`",
      "  - `pos_sim_get_events(p_session_id, p_limit)`",
      "- The host UI uses these events for a durable, queryable lifecycle timeline.",
      "",
      "## Realtime Semantics (UI Sync)",
      "- **Realtime driver:** `SNAPSHOT_SYNC` only",
      "- Broadcast is used only for instant sync/notifications; the UI state must come from the canonical snapshot.",
      "- When the host updates `snapshot_json`, it broadcasts a `SNAPSHOT_SYNC` event containing a snapshot payload.",
      "",
      "## Sale Grouping & Consistency",
      "- Every sale is grouped by `sale_id` (stored as `snapshot.active_sale_id`).",
      "- Every emitted durable event includes `payload.sale_id` so events can be grouped by sale lifecycle.",
      "- **Reset / New Sale semantics:** reset clears flow + cart + receipt + scan + fallback and starts a new `sale_id`.",
      "",
      "## Standard Lifecycle Events (Host-Side)",
      "Typical event types used in the simulator:",
      "- `SESSION_CREATED`",
      "- `NEW_SALE_STARTED`",
      "- `RESET_REQUESTED`",
      "- `CART_UPDATED`, `CART_CLEARED`",
      "- `CHECKOUT_INITIATED`, `STAGE_CHANGED`",
      "- `PAYMENT_PROCESSING`, `PAYMENT_RESULT`",
      "- `RECEIPT_ISSUANCE_STARTED`, `RECEIPT_TOKEN_READY`, `RECEIPT_ISSUANCE_FAILED`",
      "- `CUSTOMER_JOINED`, `CUSTOMER_SCANNED`",
      "- `FALLBACK_PRINTED`",
      "",
      "## Failure Modes Demonstrated",
      "The guided macros demonstrate production-relevant scenarios:",
      "- **Happy path**: payment approved → receipt token issued → customer scan success",
      "- **Issuance fail → fallback print**: receipt issuance fails → paper receipt fallback prints (if enabled)",
      "- **Scan fail → fallback print**: customer scan fails → paper receipt fallback prints (if enabled)",
      "- **Network down at pay**: payment result becomes a network error (simulated)",
      "",
      "## What This Proves for a Vendor",
      "- Receiptless integration can work with both major POS categories (web-based and Android terminal).",
      "- The system is **state-driven** (canonical snapshot) and **auditable** (durable event trail).",
      "- Failure handling and fallback printing are first-class behaviors, not afterthoughts.",
    ].join("\n");
  }, []);

  if (!POS_SIM_ENABLED) {
    return (
      <div style={{ padding: 24, maxWidth: 1100 }}>
        <h1 style={{ fontSize: 22, fontWeight: 900 }}>POS Simulator Hub</h1>
        <p style={{ marginTop: 8 }}>
          POS Simulator is not enabled. Set{" "}
          <b>NEXT_PUBLIC_POS_SIM_ENABLED=true</b>.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <h1 style={{ fontSize: 22, fontWeight: 900 }}>POS Simulator Hub</h1>
      <p style={{ marginTop: 8, opacity: 0.9 }}>
        Choose a host module to start a demo session. Both modules use the same
        architecture: canonical snapshot in{" "}
        <b>pos_sim_sessions.snapshot_json</b>, durable audit in{" "}
        <b>pos_sim_events</b> via RPC, and <b>SNAPSHOT_SYNC</b> for realtime UI
        sync.
      </p>

      <div
        style={{
          marginTop: 18,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 14,
        }}
      >
        {cards.map((c) => (
          <a
            key={c.href}
            href={c.href}
            style={{
              textDecoration: "none",
              color: "inherit",
              border: "1px solid #ddd",
              borderRadius: 14,
              padding: 14,
              background: "white",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 900, fontSize: 16 }}>{c.title}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(c.badges ?? []).map((b) => (
                  <span
                    key={b}
                    style={{
                      fontSize: 11,
                      border: "1px solid #eee",
                      borderRadius: 999,
                      padding: "4px 8px",
                      opacity: 0.85,
                    }}
                  >
                    {b}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
              {c.description}
            </div>
            <div style={{ marginTop: 12, fontSize: 12, opacity: 0.75 }}>
              Open: <span style={{ fontFamily: "monospace" }}>{c.href}</span>
            </div>
          </a>
        ))}
      </div>

      <div
        style={{
          marginTop: 18,
          border: "1px solid #ddd",
          borderRadius: 14,
          padding: 14,
          background: "white",
        }}
      >
        <div style={{ fontWeight: 900, marginBottom: 8 }}>
          Customer Display (How to open)
        </div>
        <div style={{ fontSize: 13, opacity: 0.9, lineHeight: 1.5 }}>
          The customer display URL is created per session by the create-session
          function. To open it:
          <ol style={{ marginTop: 8, paddingLeft: 18 }}>
            <li>
              Open a host module (Web POS or Android POS) and start a demo
              session.
            </li>
            <li>
              In the host UI, click <b>Open Customer Display</b>.
            </li>
            <li>
              Use the guided macros to demonstrate happy path and failure cases.
            </li>
          </ol>
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
            Tip: If you need a quick verbal explanation during demo, use:{" "}
            <span style={{ fontFamily: "monospace" }}>
              {buildCustomerDisplayHint("XXXXXX")}
            </span>
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 18,
          border: "1px solid #ddd",
          borderRadius: 14,
          padding: 14,
          background: "white",
        }}
      >
        <div
          style={{ display: "flex", justifyContent: "space-between", gap: 10 }}
        >
          <div style={{ fontWeight: 900 }}>
            POS Integration Kit v1 (One-Pager)
          </div>
          <button
            onClick={() => {
              void navigator.clipboard
                .writeText(doc)
                .catch(() =>
                  window.alert("Copy failed. Select and copy manually.")
                );
            }}
            style={{
              border: "1px solid #ccc",
              borderRadius: 10,
              padding: "8px 10px",
              background: "white",
              fontWeight: 800,
              cursor: "pointer",
            }}
            title="Copy the one-pager to clipboard"
          >
            Copy to Clipboard
          </button>
        </div>

        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
          Paste this into a doc and export as PDF for vendor follow-ups.
        </div>

        <pre
          style={{
            marginTop: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 12,
            maxHeight: 520,
            overflow: "auto",
            background: "#fafafa",
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 12,
          }}
        >
          {doc}
        </pre>
      </div>
    </div>
  );
}
