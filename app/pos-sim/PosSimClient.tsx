"use client";

import React, { useMemo, useState } from "react";

type ReceiptItemInput = {
  line_no: number;
  sku?: string | null;
  name: string;
  qty: number;
  unit_price: number;
  line_total: number;
  vat_rate?: number | null;
  vat_amount?: number | null;
};

type ReceiptIngestPayload = {
  retailer_id: string;
  store_id: string;
  terminal_code: string;

  issued_at: string;
  receipt_number?: string | null;

  currency: string;
  subtotal: number;
  vat_total: number;
  total: number;

  items: ReceiptItemInput[];
};

type ApiOk = {
  token_id: string;
  public_url: string;
  qr_url: string;
  preview_url: string | null;
};

type ApiFail = {
  error: string;
  details?: string;
  fallback: "PRINT_RECEIPT";
};

type ApiResult = ApiOk | ApiFail;

function isApiFail(v: ApiResult): v is ApiFail {
  return (v as ApiFail).fallback === "PRINT_RECEIPT";
}

declare global {
  interface Window {
    Receiptless?: {
      showReceiptQR: (args: {
        token: string;
        domain: string;
        logoUrl: string;
        title?: string;
      }) => void;
      hideReceiptQR: () => void;
    };
  }
}

function extractDomain(url: string) {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return "receipt-less.com";
  }
}

/**
 * POS Simulator (DEMO ONLY)
 * - This page is only for vendor showcase and internal experimentation.
 * - DO NOT expose real terminal keys to browser code (we don't).
 * - Calls /api/pos-sim/checkout-success which runs server-side.
 */
export default function PosSimClient() {
  const [loading, setLoading] = useState(false);
  const [lastResult, setLastResult] = useState<ApiResult | null>(null);

  // Demo payload (edit values freely)
  const payload: ReceiptIngestPayload = useMemo(
    () => ({
      retailer_id: "e84976ee-9303-4df9-b04d-e33da2d95fff",
      store_id: "c3fde414-fdf9-4c50-aaea-004a10fe50ec",
      terminal_code: "TEST-001",
      issued_at: new Date().toISOString(),
      receipt_number: `R-${Math.floor(Math.random() * 100000)
        .toString()
        .padStart(5, "0")}`,
      currency: "EUR",
      subtotal: 3.66,
      vat_total: 0.84,
      total: 4.5,
      items: [
        {
          line_no: 1,
          sku: "MILK2L",
          name: "Milk 2L",
          qty: 1,
          unit_price: 2.25,
          line_total: 2.25,
          vat_rate: 23,
          vat_amount: 0.52,
        },
        {
          line_no: 2,
          sku: "BREAD",
          name: "Bread",
          qty: 1,
          unit_price: 2.25,
          line_total: 2.25,
          vat_rate: 23,
          vat_amount: 0.52,
        },
      ],
    }),
    []
  );

  async function completeSale() {
    setLoading(true);
    setLastResult(null);

    try {
      const res = await fetch("/api/pos-sim/checkout-success", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      });

      const data = (await res.json().catch(() => null)) as ApiResult | null;

      if (!data || typeof data !== "object") {
        const fail: ApiFail = {
          error: "POS Simulator: invalid response",
          details: `HTTP ${res.status}`,
          fallback: "PRINT_RECEIPT",
        };
        setLastResult(fail);
        return;
      }

      if (!res.ok) {
        // If server returned a structured fallback, use it; otherwise force fallback.
        if (isApiFail(data)) {
          setLastResult(data);
          return;
        }

        const fail: ApiFail = {
          error: "POS Simulator: request failed",
          details: `HTTP ${res.status}`,
          fallback: "PRINT_RECEIPT",
        };
        setLastResult(fail);
        return;
      }

      // OK response: could still be fallback
      if (isApiFail(data)) {
        setLastResult(data);
        return;
      }

      // Success
      const domain = extractDomain(data.public_url);

      window.Receiptless?.showReceiptQR({
        token: data.token_id,
        domain,
        logoUrl: "https://receipt-less.com/brand/receiptless-logo.png",
        title: "Scan to save your receipt",
      });

      setLastResult(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const fail: ApiFail = {
        error: "POS Simulator: network error",
        details: msg,
        fallback: "PRINT_RECEIPT",
      };
      setLastResult(fail);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <div style={styles.headerRow}>
          <div>
            <h1 style={styles.h1}>POS Simulator</h1>
            <div style={styles.subtle}>
              Demo-only. Simulates payment success → issues token → shows QR →
              customer scans.
            </div>
          </div>

          <button
            type="button"
            onClick={completeSale}
            disabled={loading}
            style={{ ...styles.primaryBtn, opacity: loading ? 0.6 : 1 }}
          >
            {loading ? "Processing…" : "Complete Sale"}
          </button>
        </div>

        <div style={styles.divider} />

        <section style={styles.section}>
          <h2 style={styles.h2}>Receipt payload (demo)</h2>
          <pre style={styles.pre}>{JSON.stringify(payload, null, 2)}</pre>
        </section>

        <div style={styles.divider} />

        <section style={styles.section}>
          <h2 style={styles.h2}>Result</h2>

          {!lastResult ? (
            <div style={styles.subtle}>
              No result yet. Click “Complete Sale”.
            </div>
          ) : isApiFail(lastResult) ? (
            <div style={styles.bannerPrint}>
              <div style={{ fontWeight: 800 }}>
                Fallback triggered: PRINT RECEIPT
              </div>
              <div style={{ marginTop: 6, opacity: 0.9 }}>
                {lastResult.error}
                {lastResult.details ? ` — ${lastResult.details}` : ""}
              </div>
              <div style={{ marginTop: 10, fontSize: 12.5, opacity: 0.85 }}>
                In real POS: call ESC/POS print here.
              </div>
            </div>
          ) : (
            <div style={styles.bannerOk}>
              <div style={{ fontWeight: 800 }}>Digital receipt issued</div>
              <div style={{ marginTop: 6 }}>
                Token: <span style={styles.mono}>{lastResult.token_id}</span>
              </div>
              <div style={{ marginTop: 6 }}>
                Public URL:{" "}
                <a
                  href={lastResult.public_url}
                  target="_blank"
                  rel="noreferrer"
                  style={styles.link}
                >
                  {lastResult.public_url}
                </a>
              </div>
              <div style={{ marginTop: 10, fontSize: 12.5, opacity: 0.85 }}>
                QR modal should be visible now. If not, confirm
                ReceiptlessQrHost is mounted in app/layout.tsx.
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
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
    maxWidth: 980,
    background: "#ffffff",
    border: "1px solid rgba(0,0,0,0.08)",
    borderRadius: 14,
    padding: 18,
    boxShadow: "0 8px 24px rgba(0,0,0,0.06)",
  },
  headerRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  h1: {
    margin: 0,
    fontSize: 22,
    lineHeight: 1.2,
    letterSpacing: -0.2,
  },
  h2: {
    margin: "0 0 12px 0",
    fontSize: 16,
    letterSpacing: -0.1,
  },
  subtle: {
    marginTop: 6,
    fontSize: 12.5,
    color: "rgba(0,0,0,0.55)",
  },
  divider: {
    height: 1,
    background: "rgba(0,0,0,0.08)",
    margin: "16px 0",
  },
  section: {
    display: "block",
  },
  pre: {
    margin: 0,
    padding: 12,
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.08)",
    background: "rgba(0,0,0,0.02)",
    overflowX: "auto",
    fontSize: 12.5,
    lineHeight: 1.45,
  },
  primaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 40,
    padding: "0 14px",
    borderRadius: 10,
    fontSize: 13.5,
    fontWeight: 800,
    color: "#ffffff",
    background: "#111827",
    border: "1px solid rgba(0,0,0,0.08)",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  bannerOk: {
    padding: 12,
    borderRadius: 12,
    background: "rgba(16, 185, 129, 0.10)",
    border: "1px solid rgba(16, 185, 129, 0.25)",
    color: "rgba(0,0,0,0.86)",
  },
  bannerPrint: {
    padding: 12,
    borderRadius: 12,
    background: "rgba(245, 158, 11, 0.12)",
    border: "1px solid rgba(245, 158, 11, 0.25)",
    color: "rgba(0,0,0,0.86)",
  },
  mono: {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 12.5,
  },
  link: {
    color: "rgba(0,0,0,0.85)",
    textDecoration: "underline",
    wordBreak: "break-all",
  },
};
