"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  IssueReceiptBody,
  IssueReceiptResponse,
  PosSimSnapshot,
} from "@/lib/posSimTypes";

type PaymentMethod = "card" | "cash" | "apple_pay" | "google_pay";
type Outcome = "success" | "fail" | "cancelled";

type PosEvent = {
  id: string;
  session_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

const FAIL_REASONS: Array<{
  code: string;
  label: string;
  defaultMessage: string;
}> = [
  {
    code: "insufficient_funds",
    label: "Insufficient funds",
    defaultMessage: "Insufficient funds",
  },
  {
    code: "do_not_honor",
    label: "Do not honor",
    defaultMessage: "Card issuer declined the transaction",
  },
  {
    code: "invalid_pin",
    label: "Invalid PIN",
    defaultMessage: "PIN validation failed",
  },
  {
    code: "expired_card",
    label: "Expired card",
    defaultMessage: "Card is expired",
  },
  {
    code: "offline_terminal",
    label: "Terminal offline",
    defaultMessage: "Terminal is offline",
  },
  { code: "timeout", label: "Timeout", defaultMessage: "Payment timed out" },
];

function formatIso(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function compactJson(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data: unknown = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (typeof data === "object" && data && "error" in data) {
      throw new Error(String((data as { error: unknown }).error));
    }
    throw new Error(`Request failed: ${res.status}`);
  }

  return data as T;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data: unknown = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (typeof data === "object" && data && "error" in data) {
      throw new Error(String((data as { error: unknown }).error));
    }
    throw new Error(`Request failed: ${res.status}`);
  }

  return data as T;
}

function buildIssueReceiptBody(snapshot: PosSimSnapshot): IssueReceiptBody {
  const terminal = snapshot?.terminal;
  const cart = snapshot?.cart;

  if (
    !terminal?.retailer_id ||
    !terminal?.store_id ||
    !terminal?.terminal_code
  ) {
    throw new Error(
      "Missing terminal info in snapshot (retailer_id/store_id/terminal_code)."
    );
  }

  if (!cart?.currency) {
    throw new Error("Missing cart.currency in snapshot.");
  }

  if (!Array.isArray(cart.items) || cart.items.length === 0) {
    throw new Error("Cart is empty; cannot issue receipt.");
  }

  return {
    retailer_id: terminal.retailer_id,
    store_id: terminal.store_id,
    terminal_code: terminal.terminal_code,

    issued_at: new Date().toISOString(),

    currency: cart.currency,
    subtotal: cart.subtotal,
    vat_total: cart.vat_total,
    total: cart.total,

    items: cart.items,
  };
}

/**
 * Browser testing support:
 * If you don't pass snapshot as prop, you can set it in DevTools:
 *   window.posSimSnapshot = <your snapshot object>
 */
declare global {
  interface Window {
    posSimSnapshot?: unknown;
  }
}

export function PosPaymentOutcomeSimulator(props: {
  sessionId: string;

  /**
   * Optional to allow page.tsx to compile during browser-only testing.
   * If omitted, component will try to read window.posSimSnapshot.
   */
  snapshot?: PosSimSnapshot;

  defaultAmountCents?: number;
  defaultCurrency?: string;

  onPaymentSucceeded?: (args: {
    sessionId: string;
    paymentReference?: string;
  }) => void;

  // Keep off by default for manual testing
  autoIssueReceiptOnSuccess?: boolean;

  onReceiptIssued?: (resp: IssueReceiptResponse) => void;
}) {
  const {
    sessionId,
    defaultAmountCents = 1299,
    defaultCurrency = "EUR",
    onPaymentSucceeded,
    autoIssueReceiptOnSuccess = false,
    onReceiptIssued,
  } = props;

  // Local snapshot for browser test mode
  const [browserSnapshot, setBrowserSnapshot] = useState<PosSimSnapshot | null>(
    null
  );

  // Effective snapshot = prop snapshot OR browser snapshot
  const effectiveSnapshot = props.snapshot ?? browserSnapshot;

  const [amountCents, setAmountCents] = useState<number>(defaultAmountCents);
  const [currency, setCurrency] = useState<string>(defaultCurrency);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card");

  const [status, setStatus] = useState<string>("idle");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [failCode, setFailCode] = useState<string>(FAIL_REASONS[0].code);
  const [failMessage, setFailMessage] = useState<string>(
    FAIL_REASONS[0].defaultMessage
  );

  const [paymentReference, setPaymentReference] = useState<string>("");

  const [events, setEvents] = useState<PosEvent[]>([]);
  const [eventsBusy, setEventsBusy] = useState<boolean>(false);

  // A6
  const [issuingReceipt, setIssuingReceipt] = useState(false);
  const [receiptResult, setReceiptResult] =
    useState<IssueReceiptResponse | null>(null);

  const pollRef = useRef<number | null>(null);

  const selectedFail = useMemo(
    () => FAIL_REASONS.find((r) => r.code === failCode) || FAIL_REASONS[0],
    [failCode]
  );

  useEffect(() => {
    setFailMessage(selectedFail.defaultMessage);
  }, [selectedFail]);

  // Browser test mode: load snapshot from window if prop not provided
  useEffect(() => {
    if (props.snapshot) return;

    const tryLoad = () => {
      const candidate = window.posSimSnapshot;
      if (!candidate) return;

      // We cannot safely validate full shape without runtime schema,
      // but we can do a minimal structural check.
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        "terminal" in candidate &&
        "cart" in candidate
      ) {
        setBrowserSnapshot(candidate as PosSimSnapshot);
      }
    };

    tryLoad();
    const id = window.setInterval(tryLoad, 500);

    return () => window.clearInterval(id);
  }, [props.snapshot]);

  async function refreshEvents() {
    if (!sessionId) return;
    setEventsBusy(true);
    try {
      const data = await getJson<{ ok: true; events: PosEvent[] }>(
        `/api/pos-sim/events?session_id=${encodeURIComponent(sessionId)}`
      );
      setEvents(data.events ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setEventsBusy(false);
    }
  }

  useEffect(() => {
    refreshEvents();

    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => refreshEvents(), 1500);

    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function issueReceiptManual() {
    setError(null);
    setIssuingReceipt(true);
    try {
      if (!effectiveSnapshot) {
        throw new Error(
          "No snapshot available. Pass snapshot prop or set window.posSimSnapshot in DevTools."
        );
      }

      const body = buildIssueReceiptBody(effectiveSnapshot);
      const resp = await postJson<IssueReceiptResponse>(
        `/api/pos-sim/issue-receipt`,
        body
      );

      setReceiptResult(resp);
      onReceiptIssued?.(resp);

      //   // Helpful for copy/paste
      //   // eslint-disable-next-line no-console
      console.log("issue-receipt response:", resp);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Receipt issuance failed");
    } finally {
      setIssuingReceipt(false);
    }
  }

  async function startCheckout() {
    setError(null);
    setBusy(true);
    try {
      const data = await postJson<{ ok: true; status: string }>(
        `/api/pos-sim/checkout/start`,
        {
          session_id: sessionId,
          amount_cents: amountCents,
          currency,
          payment_method: paymentMethod,
        }
      );
      setStatus(data.status || "payment_pending");
      await refreshEvents();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Checkout start failed");
    } finally {
      setBusy(false);
    }
  }

  async function resolve(outcome: Outcome) {
    setError(null);
    setBusy(true);
    try {
      if (outcome === "success") {
        const ref = paymentReference?.trim() || undefined;
        const data = await postJson<{
          ok: true;
          status: string;
          payment_reference?: string;
          next?: unknown;
        }>(`/api/pos-sim/checkout/resolve`, {
          session_id: sessionId,
          outcome: "success",
          payment_reference: ref,
        });

        setStatus(data.status || "payment_succeeded");
        setPaymentReference(data.payment_reference || ref || "");
        await refreshEvents();

        onPaymentSucceeded?.({
          sessionId,
          paymentReference: data.payment_reference || ref,
        });

        if (autoIssueReceiptOnSuccess) {
          await issueReceiptManual();
        }

        return;
      }

      if (outcome === "fail") {
        const data = await postJson<{
          ok: true;
          status: string;
          failure_code?: string;
          failure_message?: string;
        }>(`/api/pos-sim/checkout/resolve`, {
          session_id: sessionId,
          outcome: "fail",
          failure_code: failCode,
          failure_message: failMessage,
        });
        setStatus(data.status || "payment_failed");
        await refreshEvents();
        return;
      }

      const data = await postJson<{ ok: true; status: string }>(
        `/api/pos-sim/checkout/resolve`,
        {
          session_id: sessionId,
          outcome: "cancelled",
        }
      );
      setStatus(data.status || "payment_cancelled");
      await refreshEvents();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setBusy(false);
    }
  }

  const statusTone = status.includes("succeed")
    ? "bg-green-50 border-green-200 text-green-900"
    : status.includes("fail")
    ? "bg-red-50 border-red-200 text-red-900"
    : status.includes("cancel")
    ? "bg-amber-50 border-amber-200 text-amber-900"
    : status.includes("pending")
    ? "bg-blue-50 border-blue-200 text-blue-900"
    : "bg-gray-50 border-gray-200 text-gray-900";

  return (
    <div className="w-full max-w-5xl space-y-4">
      <div className={`rounded-xl border p-4 ${statusTone}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm opacity-80">Session</div>
            <div className="font-mono text-sm break-all">{sessionId}</div>
          </div>
          <div className="text-right">
            <div className="text-sm opacity-80">Status</div>
            <div className="font-semibold">{status}</div>
          </div>
        </div>

        {error ? (
          <div className="mt-3 rounded-lg border border-red-200 bg-white p-3 text-red-700">
            <div className="font-semibold">Error</div>
            <div className="text-sm">{error}</div>
          </div>
        ) : null}

        {/* Browser test mode hint */}
        {!props.snapshot && !effectiveSnapshot ? (
          <div className="mt-3 rounded-lg border bg-white p-3 text-xs text-amber-700">
            Snapshot not provided. For browser testing, set{" "}
            <span className="font-mono">window.posSimSnapshot</span> in DevTools
            to enable receipt issuance.
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border bg-white p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Payment Outcome Simulator</h2>
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
              disabled={busy}
              onClick={refreshEvents}
              title="Refresh events"
            >
              Refresh
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">
                Amount (cents)
              </label>
              <input
                className="w-full rounded-lg border px-3 py-2 text-sm"
                type="number"
                min={1}
                value={amountCents}
                onChange={(e) => setAmountCents(Number(e.target.value || 0))}
              />
              <div className="mt-1 text-xs text-gray-500">
                Display: {(amountCents / 100).toFixed(2)} {currency}
              </div>
            </div>

            <div>
              <label className="block text-sm text-gray-600 mb-1">
                Currency
              </label>
              <input
                className="w-full rounded-lg border px-3 py-2 text-sm"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
              <div className="mt-1 text-xs text-gray-500">Default: EUR</div>
            </div>

            <div>
              <label className="block text-sm text-gray-600 mb-1">
                Payment Method
              </label>
              <select
                className="w-full rounded-lg border px-3 py-2 text-sm"
                value={paymentMethod}
                onChange={(e) =>
                  setPaymentMethod(e.target.value as PaymentMethod)
                }
              >
                <option value="card">Card</option>
                <option value="apple_pay">Apple Pay</option>
                <option value="google_pay">Google Pay</option>
                <option value="cash">Cash (simulate)</option>
              </select>
              <div className="mt-1 text-xs text-gray-500">For demo flows</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-lg bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
              onClick={startCheckout}
              disabled={busy || !sessionId || amountCents < 1}
            >
              Start Checkout
            </button>
          </div>

          <hr />

          <div className="space-y-2">
            <div className="text-sm font-semibold">Approve (Success)</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="block text-xs text-gray-600 mb-1">
                  Payment Reference (optional)
                </label>
                <input
                  className="w-full rounded-lg border px-3 py-2 text-sm font-mono"
                  placeholder="SIM-8H3K2"
                  value={paymentReference}
                  onChange={(e) => setPaymentReference(e.target.value)}
                />
              </div>
              <div className="flex items-end">
                <button
                  className="w-full rounded-lg border bg-green-600 px-4 py-2 text-sm text-white hover:opacity-95 disabled:opacity-50"
                  onClick={() => resolve("success")}
                  disabled={busy || !sessionId}
                >
                  Approve Payment
                </button>
              </div>
            </div>
            <div className="text-xs text-gray-500">
              On success, your API returns{" "}
              <span className="font-mono">next: issue_receipt</span> (A6).
            </div>
          </div>

          <hr />

          {/* A6 Manual Test */}
          <div className="space-y-2">
            <div className="text-sm font-semibold">Receipt Issuance (A6)</div>
            <button
              className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
              onClick={issueReceiptManual}
              disabled={
                busy || issuingReceipt || !sessionId || !effectiveSnapshot
              }
              title="Calls /api/pos-sim/issue-receipt using snapshot.cart + snapshot.terminal"
            >
              {issuingReceipt ? "Issuing…" : "Test Issue Receipt Now"}
            </button>

            {receiptResult ? (
              <div className="rounded-lg border bg-white p-3">
                <div className="text-xs text-gray-600 mb-2">
                  Raw response (paste this back to me)
                </div>
                <pre className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-2 text-xs">
                  {compactJson(receiptResult)}
                </pre>
              </div>
            ) : (
              <div className="text-xs text-gray-500">
                No issuance response captured yet.
              </div>
            )}
          </div>

          <hr />

          <div className="space-y-2">
            <div className="text-sm font-semibold">Decline (Fail)</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">
                  Failure Code
                </label>
                <select
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  value={failCode}
                  onChange={(e) => setFailCode(e.target.value)}
                >
                  {FAIL_REASONS.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs text-gray-600 mb-1">
                  Failure Message
                </label>
                <input
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  value={failMessage}
                  onChange={(e) => setFailMessage(e.target.value)}
                />
              </div>
            </div>

            <button
              className="rounded-lg border bg-red-600 px-4 py-2 text-sm text-white hover:opacity-95 disabled:opacity-50"
              onClick={() => resolve("fail")}
              disabled={busy || !sessionId}
            >
              Decline Payment
            </button>
          </div>

          <hr />

          <div className="space-y-2">
            <div className="text-sm font-semibold">Cancel</div>
            <button
              className="rounded-lg border bg-amber-600 px-4 py-2 text-sm text-white hover:opacity-95 disabled:opacity-50"
              onClick={() => resolve("cancelled")}
              disabled={busy || !sessionId}
            >
              Customer Cancelled
            </button>
          </div>
        </div>

        <div className="rounded-xl border bg-white p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Event Timeline</h2>
            <div className="text-xs text-gray-500">
              {eventsBusy
                ? "Updating…"
                : `Last update: ${new Date().toLocaleTimeString()}`}
            </div>
          </div>

          {events.length === 0 ? (
            <div className="rounded-lg border bg-gray-50 p-4 text-sm text-gray-700">
              No events yet. Click{" "}
              <span className="font-semibold">Start Checkout</span> to generate
              timeline entries.
            </div>
          ) : (
            <div className="space-y-2 max-h-[520px] overflow-auto pr-1">
              {events.map((ev) => (
                <div key={ev.id} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="font-mono text-sm">{ev.event_type}</div>
                    <div className="text-xs text-gray-500 whitespace-nowrap">
                      {formatIso(ev.created_at)}
                    </div>
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-gray-600">
                      Payload
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-2 text-xs">
                      {compactJson(ev.payload)}
                    </pre>
                  </details>
                </div>
              ))}
            </div>
          )}

          <div className="text-xs text-gray-500">
            Polling every 1.5s for demo realism. If you prefer true realtime,
            switch to Supabase realtime later.
          </div>
        </div>
      </div>
    </div>
  );
}
