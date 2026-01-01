// components/ReceiptlessQrModal.tsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import QRCode from "qrcode";

type Props = {
  open: boolean;
  token: string;
  domain: string; // e.g. "receipt-less.com" or "r.receipt-less.com"
  onClose: () => void;

  // Branding
  logoUrl: string; // e.g. "https://receipt-less.com/brand/receiptless-logo.png"
  title?: string;

  // Optional tuning
  qrSize?: number; // default 300
  ecc?: "L" | "M" | "Q" | "H"; // default "M"
};

type ReadyState = { status: "ready"; dataUrl: string; receiptUrl: string };
type ErrorState = { status: "error"; message: string; receiptUrl: string };
type LoadingState = { status: "loading"; receiptUrl: string };
type QrState = ReadyState | ErrorState | LoadingState;

function buildReceiptUrl(domain: string, token: string) {
  const cleanDomain = domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const cleanToken = String(token || "").trim();
  return `https://${cleanDomain}/r/${encodeURIComponent(cleanToken)}`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

async function loadImageAsDataUrl(url: string): Promise<string> {
  // Best practice: host on same domain to avoid CORS surprises.
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`Logo fetch failed (${res.status})`);

  const blob = await res.blob();

  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Logo read failed"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(blob);
  });
}

async function decodeImage(logoDataUrl: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Logo decode failed"));
    img.src = logoDataUrl;
  });
}

async function makeBrandedQrDataUrl(args: {
  receiptUrl: string;
  logoUrl: string;
  qrSize: number;
  ecc: "L" | "M" | "Q" | "H";
}) {
  const { receiptUrl, logoUrl, qrSize, ecc } = args;

  // Generate QR to offscreen canvas
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, receiptUrl, {
    errorCorrectionLevel: ecc,
    width: qrSize,
    margin: 2,
    color: { dark: "#000000", light: "#FFFFFF" },
  });

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");

  // Load + decode logo
  const logoDataUrl = await loadImageAsDataUrl(logoUrl);
  const logoImg = await decodeImage(logoDataUrl);

  // Logo sizing: keep <= 18% of width for scan reliability
  const logoSize = Math.round(qrSize * 0.18); // 54px at 300
  const pad = Math.round(qrSize * 0.033); // ~10px at 300
  const r = Math.round(qrSize * 0.033); // rounded bg

  const x = Math.round((qrSize - logoSize) / 2);
  const y = Math.round((qrSize - logoSize) / 2);

  // White rounded background behind logo
  ctx.save();
  ctx.fillStyle = "#FFFFFF";
  roundRect(ctx, x - pad, y - pad, logoSize + pad * 2, logoSize + pad * 2, r);
  ctx.fill();
  ctx.restore();

  // Draw logo
  ctx.drawImage(logoImg, x, y, logoSize, logoSize);

  return canvas.toDataURL("image/png");
}

export function ReceiptlessQrModal({
  open,
  token,
  domain,
  onClose,
  logoUrl,
  title = "Scan to save your receipt",
  qrSize = 300,
  ecc = "M",
}: Props) {
  const receiptUrl = useMemo(
    () => buildReceiptUrl(domain, token),
    [domain, token]
  );

  // Only keep state relevant while open; do not setState "idle" on close.
  const [state, setState] = useState<QrState>(() => ({
    status: "loading",
    receiptUrl,
  }));

  // When the modal opens (or key inputs change), generate QR asynchronously.
  useEffect(() => {
    if (!open) return;

    let alive = true;

    // immediately represent "loading" for the current receiptUrl without a sync setState-in-effect warning
    // We do it in a microtask to satisfy strict lint setups.
    Promise.resolve().then(() => {
      if (!alive) return;
      setState({ status: "loading", receiptUrl });
    });

    (async () => {
      try {
        const dataUrl = await makeBrandedQrDataUrl({
          receiptUrl,
          logoUrl,
          qrSize,
          ecc,
        });
        if (!alive) return;
        setState({ status: "ready", dataUrl, receiptUrl });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "QR generation failed";
        if (!alive) return;
        setState({ status: "error", message: msg, receiptUrl });
      }
    })();

    const t = window.setTimeout(onClose, 12000);

    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [open, receiptUrl, logoUrl, qrSize, ecc, onClose]);

  if (!open) return null;

  return (
    <div
      style={styles.backdrop}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div style={styles.card} onClick={(e) => e.stopPropagation()}>
        <div style={styles.title}>{title}</div>

        {state.status === "loading" ? (
          <div style={styles.loading}>Generating QR…</div>
        ) : null}

        {state.status === "ready" ? (
          <div style={styles.qrWrap}>
            <Image
              src={state.dataUrl}
              alt="Receipt QR code"
              width={qrSize}
              height={qrSize}
              priority
              unoptimized
              style={styles.qrImg as React.CSSProperties}
            />
          </div>
        ) : null}

        {state.status === "error" ? (
          <div style={styles.errorBox}>
            <div style={{ fontWeight: 900 }}>Unable to generate branded QR</div>
            <div style={{ marginTop: 6, opacity: 0.9 }}>{state.message}</div>
            <div style={{ marginTop: 10 }}>
              <a href={receiptUrl} style={styles.link}>
                Open receipt link
              </a>
            </div>
          </div>
        ) : null}

        <div style={styles.url}>{receiptUrl}</div>

        <button style={styles.btn} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.50)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 999999,
  },
  card: {
    width: "100%",
    maxWidth: 440,
    background: "#fff",
    borderRadius: 14,
    padding: 18,
    boxShadow: "0 18px 55px rgba(0,0,0,0.25)",
    textAlign: "center",
    border: "1px solid rgba(0,0,0,0.08)",
  },
  title: { fontSize: 16, fontWeight: 900, marginBottom: 12 },
  loading: { padding: "28px 0", color: "rgba(0,0,0,0.70)", fontSize: 14 },
  qrWrap: { display: "flex", justifyContent: "center", paddingBottom: 6 },
  qrImg: {
    borderRadius: 10,
    border: "1px solid rgba(0,0,0,0.08)",
    background: "#fff",
  },
  url: {
    marginTop: 10,
    fontSize: 12,
    color: "rgba(0,0,0,0.55)",
    wordBreak: "break-all",
  },
  btn: {
    marginTop: 14,
    width: "100%",
    height: 40,
    borderRadius: 10,
    border: "1px solid rgba(0,0,0,0.12)",
    background: "#111827",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },
  errorBox: {
    margin: "10px 0",
    padding: 12,
    borderRadius: 12,
    background: "rgba(239, 68, 68, 0.10)",
    border: "1px solid rgba(239, 68, 68, 0.25)",
    color: "rgba(0,0,0,0.86)",
    textAlign: "left",
  },
  link: {
    color: "#111827",
    fontWeight: 900,
    textDecoration: "underline",
  },
};
