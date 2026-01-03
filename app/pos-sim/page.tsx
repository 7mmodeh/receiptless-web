"use client";

// app/pos-sim/page.tsx
import React, { useState } from "react";
import { PosPaymentOutcomeSimulator } from "@/components/PosPaymentOutcomeSimulator";

export default function PosSimPage() {
  const [sessionId, setSessionId] = useState<string>("");

  return (
    <main className="p-6 space-y-4">
      <div className="max-w-5xl rounded-xl border bg-white p-4">
        <div className="text-lg font-semibold">POS Simulator (A6 Manual)</div>
        <div className="mt-1 text-sm text-gray-600">
          Paste a <span className="font-mono">session_id</span> (uuid) that
          exists in <span className="font-mono">public.pos_sim_snapshots</span>.
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
          <input
            className="w-full rounded-lg border px-3 py-2 text-sm font-mono"
            placeholder="e.g. 9591244f-b16a-43e3-b0d5-9b5484e170c2"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value.trim())}
          />
          <button
            className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
            onClick={() => setSessionId("")}
            type="button"
          >
            Clear
          </button>
        </div>
      </div>

      <PosPaymentOutcomeSimulator sessionId={sessionId} />
    </main>
  );
}
