// app/admin/returns/ReturnsDeskClient.tsx
"use client";

import React, { useMemo, useRef, useState } from "react";
import type { ReturnDeskViewModel } from "@/lib/returnsDeskTypes";
import { returnsConsume, returnsValidate } from "@/lib/returnsDeskClient";

/* ---------------------------
   Small helpers
---------------------------- */
function isUuid(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s
  );
}

function extractTokenId(scan: string): string | null {
  const raw = scan.trim();
  if (!raw) return null;

  // If it's already a UUID
  if (isUuid(raw)) return raw;

  // If it's a URL containing /r/[tokenId]
  try {
    const u = new URL(raw);
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("r");
    if (idx >= 0 && parts[idx + 1] && isUuid(parts[idx + 1])) {
      return parts[idx + 1];
    }
  } catch {
    // not a URL
  }

  // Extend here later if QR payloads vary
  return null;
}

function errorMessage(e: unknown): string {
  if (
    e &&
    typeof e === "object" &&
    "name" in e &&
    (e as { name?: unknown }).name === "AbortError"
  ) {
    return "Request aborted";
  }
  if (e && typeof e === "object" && "message" in e) {
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return msg;
  }
  if (typeof e === "string" && e.trim()) return e;
  return "Network error";
}

/* ---------------------------
   Status panel (declared OUTSIDE render)
---------------------------- */
function StatusPanel({ vm }: { vm: ReturnDeskViewModel }) {
  if (vm.kind === "IDLE") {
    return (
      <div className="rounded-xl border p-6">
        <div className="text-lg font-semibold">Ready</div>
        <div className="text-sm opacity-70">
          Configure terminal details, then scan or paste a receipt token.
        </div>
      </div>
    );
  }

  if (vm.kind === "LOOKUP_LOADING") {
    return (
      <div className="rounded-xl border p-6">
        <div className="text-lg font-semibold">Verifying…</div>
        <div className="text-sm opacity-70">
          Checking authenticity and status.
        </div>
      </div>
    );
  }

  if (vm.kind === "CONSUME_LOADING") {
    return (
      <div className="rounded-xl border p-6">
        <div className="text-lg font-semibold">Consuming…</div>
        <div className="text-sm opacity-70">
          Irreversible operation in progress.
        </div>
      </div>
    );
  }

  if (vm.kind === "NETWORK_ERROR") {
    return (
      <div className="rounded-xl border p-6">
        <div className="text-lg font-semibold">Network / Server Error</div>
        <div className="text-sm opacity-70">{vm.message}</div>
      </div>
    );
  }

  if (vm.kind === "INVALID") {
    return (
      <div className="rounded-xl border p-6">
        <div className="text-lg font-semibold">Invalid Receipt</div>
        <div className="text-sm opacity-70">
          {vm.reason}
          {vm.requestId ? ` (${vm.requestId})` : ""}
        </div>
      </div>
    );
  }

  // ELIGIBLE / CONSUMED
  const isConsumed = vm.kind === "CONSUMED";
  return (
    <div className="rounded-xl border p-6 space-y-4">
      <div>
        <div className="text-xl font-semibold">
          {isConsumed ? "Already Used for Return" : "Valid – Not Consumed"}
        </div>
        <div className="text-sm opacity-70">Request: {vm.requestId}</div>
      </div>

      <div className="rounded-lg border p-4 space-y-2">
        <div className="text-sm font-medium">Receipt Summary</div>
        <div className="text-sm space-y-1">
          <div>
            <span className="opacity-70">Receipt ID:</span> {vm.receipt.id}
          </div>
          <div>
            <span className="opacity-70">Issued at:</span>{" "}
            {vm.receipt.issued_at}
          </div>
          <div>
            <span className="opacity-70">Currency:</span> {vm.receipt.currency}
          </div>
          <div>
            <span className="opacity-70">Total:</span> {vm.receipt.total}
          </div>
          <div>
            <span className="opacity-70">Status:</span>{" "}
            {vm.receipt.status ?? "unknown"}
          </div>
          <div>
            <span className="opacity-70">Consumed at:</span>{" "}
            {vm.receipt.consumed_at ?? "—"}
          </div>
        </div>
      </div>

      <div className="rounded-lg border p-4">
        <div className="text-sm font-medium mb-2">Items</div>
        <div className="space-y-2">
          {vm.items.length === 0 ? (
            <div className="text-sm opacity-70">No items found.</div>
          ) : (
            vm.items.map((it) => (
              <div key={it.line_no} className="flex justify-between text-sm">
                <div className="max-w-[70%]">
                  <div className="font-medium">
                    {it.line_no}. {it.name}
                  </div>
                  <div className="opacity-70">
                    {it.qty} × {it.unit_price} {it.sku ? `• ${it.sku}` : ""}
                  </div>
                </div>
                <div className="font-medium">{it.line_total}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {!isConsumed && (
        <div className="text-sm opacity-70">
          Clicking “Confirm Return” will permanently consume this receipt.
        </div>
      )}
    </div>
  );
}

/* ---------------------------
   Main component
---------------------------- */
export default function ReturnsDeskClient() {
  const [storeId, setStoreId] = useState("");
  const [terminalCode, setTerminalCode] = useState("");
  const [verifierKey, setVerifierKey] = useState("");

  const [scanInput, setScanInput] = useState("");
  const [vm, setVm] = useState<ReturnDeskViewModel>({ kind: "IDLE" });

  const lastLookupRef = useRef<{ tokenId: string; at: number } | null>(null);

  const canLookup = useMemo(() => {
    return (
      isUuid(storeId.trim()) &&
      terminalCode.trim().length > 0 &&
      verifierKey.trim().length > 0 &&
      extractTokenId(scanInput) !== null
    );
  }, [storeId, terminalCode, verifierKey, scanInput]);

  async function doLookup() {
    const tokenId = extractTokenId(scanInput);
    if (!tokenId) {
      setVm({ kind: "INVALID", reason: "MALFORMED" });
      return;
    }
    if (
      !isUuid(storeId.trim()) ||
      !terminalCode.trim() ||
      !verifierKey.trim()
    ) {
      setVm({
        kind: "NETWORK_ERROR",
        message: "Missing store/terminal/verifier key configuration.",
      });
      return;
    }

    // Flood control
    const now = Date.now();
    const last = lastLookupRef.current;
    if (last && last.tokenId === tokenId && now - last.at < 1500) return;
    lastLookupRef.current = { tokenId, at: now };

    setVm({ kind: "LOOKUP_LOADING" });

    try {
      const res = await returnsValidate({
        token_id: tokenId,
        store_id: storeId.trim(),
        terminal_code: terminalCode.trim(),
        verifier_key: verifierKey.trim(),
      });

      if (!res.ok) {
        // Map known "invalid" cases
        if (
          res.error === "token_not_found" ||
          res.error === "invalid_token_id_uuid" ||
          res.error === "invalid_store_id_uuid"
        ) {
          setVm({
            kind: "INVALID",
            reason: res.error,
            requestId: res.request_id,
          });
          return;
        }
        setVm({
          kind: "NETWORK_ERROR",
          message: `${res.error} (${res.request_id})`,
        });
        return;
      }

      const consumed =
        (res.receipt?.status ?? "").toLowerCase() === "consumed" ||
        res.receipt?.consumed_at != null ||
        (res.token?.status ?? "").toLowerCase() === "consumed" ||
        res.token?.consumed_at != null;

      setVm({
        kind: consumed ? "CONSUMED" : "ELIGIBLE",
        requestId: res.request_id,
        receipt: res.receipt,
        token: res.token,
        items: res.items ?? [],
      });
    } catch (e: unknown) {
      setVm({ kind: "NETWORK_ERROR", message: errorMessage(e) });
    }
  }

  async function doConsume() {
    if (vm.kind !== "ELIGIBLE") return;

    setVm({ kind: "CONSUME_LOADING", receiptId: vm.receipt.id });

    try {
      const res = await returnsConsume({
        token_id: vm.token.token_id,
        store_id: storeId.trim(),
        terminal_code: terminalCode.trim(),
        verifier_key: verifierKey.trim(),
        reason: "return_refund",
      });

      if (!res.ok) {
        setVm({
          kind: "NETWORK_ERROR",
          message: `${res.error} (${res.request_id})`,
        });
        return;
      }

      // Refresh via verify to display items + consumed status
      setScanInput(vm.token.token_id);
      await doLookup();
    } catch (e: unknown) {
      setVm({ kind: "NETWORK_ERROR", message: errorMessage(e) });
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Return Desk</h1>
          <p className="text-sm opacity-70">
            Scan → Verify → Consume (irreversible)
          </p>
        </div>
        <div className="text-xs opacity-60">
          RL-071 UI spec • RL-070.9 contract
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <div className="rounded-xl border p-4 space-y-3">
            <div className="text-sm font-medium">Terminal configuration</div>

            <div className="space-y-2">
              <label className="block text-xs opacity-70">
                Store ID (UUID)
              </label>
              <input
                className="w-full rounded-lg border px-3 py-2 text-sm"
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                placeholder="store_id"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-xs opacity-70">Terminal Code</label>
              <input
                className="w-full rounded-lg border px-3 py-2 text-sm"
                value={terminalCode}
                onChange={(e) => setTerminalCode(e.target.value)}
                placeholder="terminal_code"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-xs opacity-70">Verifier Key</label>
              <input
                className="w-full rounded-lg border px-3 py-2 text-sm"
                value={verifierKey}
                onChange={(e) => setVerifierKey(e.target.value)}
                placeholder="x-verifier-key"
              />
              <div className="text-[11px] opacity-60">
                Stored locally on the return terminal. Never share.
              </div>
            </div>
          </div>

          <div className="rounded-xl border p-4 space-y-3">
            <div className="text-sm font-medium">Scan / Paste</div>
            <input
              className="w-full rounded-lg border px-3 py-2 text-sm"
              value={scanInput}
              onChange={(e) => setScanInput(e.target.value)}
              placeholder="Paste receipt URL or token UUID"
              onKeyDown={(e) => {
                if (e.key === "Enter") doLookup();
              }}
            />
            <div className="flex gap-2">
              <button
                className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50"
                disabled={
                  !canLookup ||
                  vm.kind === "LOOKUP_LOADING" ||
                  vm.kind === "CONSUME_LOADING"
                }
                onClick={doLookup}
              >
                Lookup
              </button>

              <button
                className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50"
                disabled={vm.kind !== "ELIGIBLE"}
                onClick={doConsume}
              >
                Confirm Return (Consume)
              </button>

              <button
                className="ml-auto rounded-lg border px-4 py-2 text-sm"
                onClick={() => {
                  setScanInput("");
                  setVm({ kind: "IDLE" });
                }}
              >
                Reset
              </button>
            </div>
          </div>
        </div>

        <StatusPanel vm={vm} />
      </div>
    </div>
  );
}
