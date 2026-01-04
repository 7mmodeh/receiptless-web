// components/ReceiptlessQrHost.tsx

"use client";

import React, { useEffect, useState } from "react";
import { ReceiptlessQrModal } from "@/components/ReceiptlessQrModal";

type ShowArgs = {
  token: string;
  domain: string;
  logoUrl: string;
  title?: string;
};

declare global {
  interface Window {
    Receiptless?: {
      showReceiptQR: (args: ShowArgs) => void;
      hideReceiptQR: () => void;
    };
  }
}

export function ReceiptlessQrHost(props: {
  defaultDomain: string;
  defaultLogoUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const [args, setArgs] = useState<ShowArgs>({
    token: "",
    domain: props.defaultDomain,
    logoUrl: props.defaultLogoUrl,
  });

  useEffect(() => {
    // Expose a tiny global API so any POS “checkout success” handler can call it.
    window.Receiptless = {
      showReceiptQR: (a: ShowArgs) => {
        setArgs({
          token: a.token,
          domain: a.domain || props.defaultDomain,
          logoUrl: a.logoUrl || props.defaultLogoUrl,
          title: a.title,
        });
        setOpen(true);
      },
      hideReceiptQR: () => setOpen(false),
    };

    return () => {
      // Cleanup if the component ever unmounts
      delete window.Receiptless;
    };
  }, [props.defaultDomain, props.defaultLogoUrl]);

  return (
    <ReceiptlessQrModal
      open={open}
      onClose={() => setOpen(false)}
      token={args.token}
      domain={args.domain}
      logoUrl={args.logoUrl}
      title={args.title || "Scan to save your receipt"}
    />
  );
}
