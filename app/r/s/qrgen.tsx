"use client";
import React, { useEffect, useState } from "react";
import QRCode from "qrcode";

export function ReceiptQrModal({
  open,
  url,
  onClose,
}: {
  open: boolean;
  url: string;
  onClose: () => void;
}) {
  const [svg, setSvg] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    let alive = true;

    (async () => {
      const s = await QRCode.toString(url, {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 2,
        scale: 6,
      });
      if (alive) setSvg(s);
    })();

    const t = setTimeout(onClose, 12000); // auto-close after 12s
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, url, onClose]);

  if (!open) return null;

  return (
    <div
      style={styles.backdrop}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div style={styles.card} onClick={(e) => e.stopPropagation()}>
        <div style={styles.title}>Scan to save your receipt</div>
        <div style={styles.qrWrap} dangerouslySetInnerHTML={{ __html: svg }} />
        <div style={styles.url}>{url}</div>
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
    background: "rgba(0,0,0,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 9999,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    background: "#fff",
    borderRadius: 14,
    padding: 18,
    boxShadow: "0 18px 55px rgba(0,0,0,0.25)",
    textAlign: "center",
  },
  title: { fontSize: 16, fontWeight: 800, marginBottom: 12 },
  qrWrap: { display: "flex", justifyContent: "center" },
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
    fontWeight: 800,
    cursor: "pointer",
  },
};
