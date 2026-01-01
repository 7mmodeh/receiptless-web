"use client";

import React, { useState } from "react";
import { ReceiptlessQrModal } from "@/components/ReceiptlessQrModal";

export default function QrTestPage() {
  const [open, setOpen] = useState(true);

  // HARD-CODED TEST TOKEN (replace anytime)
  const TEST_TOKEN = "9fe4a303-429f-4ff7-9c6a-6c97177c19cc";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f6f7f9",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <button
        onClick={() => setOpen(true)}
        style={{
          padding: "14px 20px",
          fontSize: 16,
          fontWeight: 800,
          borderRadius: 12,
          background: "#111827",
          color: "#fff",
          border: "none",
          cursor: "pointer",
        }}
      >
        Show Receipt QR
      </button>

      <ReceiptlessQrModal
        open={open}
        onClose={() => setOpen(false)}
        token={TEST_TOKEN}
        domain="receipt-less.com"
        logoUrl="https://receipt-less.com/brand/receiptless-logo.png"
        title="Scan to save your receipt"
      />
    </div>
  );
}
