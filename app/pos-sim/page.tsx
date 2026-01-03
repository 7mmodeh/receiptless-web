"use client";

// app/pos-sim/page.tsx

import { PosPaymentOutcomeSimulator } from "@/components/PosPaymentOutcomeSimulator";

export default function PosSimPage() {
  const sessionId = "PASTE_SESSION_UUID_HERE"; // typically from your session creation step

  return (
    <main className="p-6">
      <PosPaymentOutcomeSimulator
        sessionId={sessionId}
        defaultAmountCents={1299}
        defaultCurrency="EUR"
        onPaymentSucceeded={({ sessionId }) => {
          // Optional: auto-call A6 here if you want full demo chaining.
          // fetch("/api/pos-sim/issue-receipt", { method: "POST", ... })
          console.log("Payment succeeded for session:", sessionId);
        }}
      />
    </main>
  );
}
