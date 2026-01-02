"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  RealtimeChannel,
  RealtimeChannelSendResponse,
} from "@supabase/supabase-js";

import { getSupabaseClient } from "@/lib/supabaseClient";
import type {
  BroadcastMessage,
  JsonObject,
  PosSimEvent,
  PosSimSnapshot,
  CartItem,
} from "@/lib/posSimTypes";
import { channelName, makeEvent, snapshotPayload } from "@/lib/posSimRealtime";

const POS_SIM_ENABLED =
  (process.env.NEXT_PUBLIC_POS_SIM_ENABLED ?? "").toLowerCase() === "true" ||
  process.env.NEXT_PUBLIC_POS_SIM_ENABLED === "1";

const DEMO_STORE_ID = "c3fde414-fdf9-4c50-aaea-004a10fe50ec";
const DEMO_TERMINAL_CODE = "TEST-001";

type SubscribeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

type CatalogItem = {
  sku: string;
  name: string;
  price: number; // ex VAT
  vat_rate: number; // 0.23 etc.
};

const CATALOG: CatalogItem[] = [
  { sku: "SKU-001", name: "Mineral Water 500ml", price: 1.2, vat_rate: 0.23 },
  { sku: "SKU-002", name: "Chicken Wrap", price: 4.5, vat_rate: 0.13 },
  { sku: "SKU-003", name: "Chocolate Bar", price: 1.6, vat_rate: 0.23 },
  { sku: "SKU-004", name: "Coffee (Large)", price: 3.2, vat_rate: 0.23 },
];

function isPosSimEvent(v: unknown): v is PosSimEvent {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.type === "string" &&
    typeof r.session_id === "string" &&
    typeof r.ts === "string" &&
    typeof r.payload === "object" &&
    r.payload !== null
  );
}

async function safeSend(
  ch: RealtimeChannel,
  ev: PosSimEvent
): Promise<RealtimeChannelSendResponse> {
  return ch.send({ type: "broadcast", event: "pos_sim", payload: ev });
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function recalcCart(items: CartItem[]) {
  const subtotal = round2(items.reduce((s, i) => s + (i.line_total || 0), 0));
  const vat_total = round2(items.reduce((s, i) => s + (i.vat_amount || 0), 0));
  const total = round2(subtotal + vat_total);
  return { subtotal, vat_total, total };
}

function nextLineNo(items: CartItem[]) {
  const max = items.reduce((m, i) => Math.max(m, i.line_no), 0);
  return max + 1;
}

function newSaleId() {
  // Works in modern browsers; fallback to timestamp if needed
  try {
    return crypto.randomUUID();
  } catch {
    return `sale_${Date.now()}`;
  }
}

export default function WebPosSimPageA3() {
  const supabase = useMemo(() => getSupabaseClient(), []);

  const [creating, setCreating] = useState(false);
  const [hostStatus, setHostStatus] = useState<string>("Idle");
  const [session, setSession] = useState<{
    session_id: string;
    session_code: string;
    customer_url: string;
    snapshot: PosSimSnapshot;
  } | null>(null);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const snapshotRef = useRef<PosSimSnapshot | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  // For simulating async payment processing
  const payTimerRef = useRef<number | null>(null);

  const customerFullUrl = useMemo(() => {
    if (!session) return "";
    if (typeof window === "undefined") return session.customer_url;
    return `${window.location.origin}${session.customer_url}`;
  }, [session]);

  useEffect(() => {
    return () => {
      const ch = channelRef.current;
      channelRef.current = null;
      if (ch) supabase.removeChannel(ch);

      if (payTimerRef.current) {
        window.clearTimeout(payTimerRef.current);
        payTimerRef.current = null;
      }
    };
  }, [supabase]);

  async function persistAndBroadcast(nextSnap: PosSimSnapshot) {
    const sid = sessionIdRef.current;
    const ch = channelRef.current;
    if (!sid || !ch) return;

    snapshotRef.current = nextSnap;
    setSession((prev) => (prev ? { ...prev, snapshot: nextSnap } : prev));

    const { error: upErr } = await supabase
      .from("pos_sim_sessions")
      .update({ snapshot_json: nextSnap })
      .eq("session_id", sid);

    if (upErr) {
      console.error("Snapshot DB update failed:", upErr);
      setHostStatus(`DB update failed: ${upErr.message}`);
    }

    // A2/A3: broadcast cart update + snapshot sync
    const cartEv = makeEvent("CART_UPDATED", sid, snapshotPayload(nextSnap));
    const snapEv = makeEvent("SNAPSHOT_SYNC", sid, snapshotPayload(nextSnap));
    await safeSend(ch, cartEv);
    await safeSend(ch, snapEv);
  }

  function getSnap(): PosSimSnapshot | null {
    return snapshotRef.current ?? session?.snapshot ?? null;
  }

  function cartIsEmpty(snap: PosSimSnapshot) {
    return (
      (snap.cart.items ?? []).length === 0 || Number(snap.cart.total ?? 0) <= 0
    );
  }

  async function startSession() {
    if (!POS_SIM_ENABLED) return;

    setCreating(true);
    setHostStatus("Creating session...");

    try {
      const { data, error } = await supabase.functions.invoke(
        "pos-sim-create-session",
        {
          body: {
            mode: "web_pos",
            store_id: DEMO_STORE_ID,
            terminal_code: DEMO_TERMINAL_CODE,
          } satisfies JsonObject,
        }
      );

      if (error) throw error;

      const rd = data as Record<string, unknown>;
      const session_id =
        typeof rd.session_id === "string" ? rd.session_id : null;
      const session_code =
        typeof rd.session_code === "string" ? rd.session_code : null;
      const customer_url =
        typeof rd.customer_url === "string" ? rd.customer_url : null;
      const snapshot = rd.snapshot as PosSimSnapshot | undefined;

      if (!session_id || !session_code || !customer_url || !snapshot) {
        throw new Error("Invalid create-session response");
      }

      const created = { session_id, session_code, customer_url, snapshot };
      setSession(created);
      snapshotRef.current = snapshot;
      sessionIdRef.current = session_id;

      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }

      setHostStatus("Connecting realtime...");

      const ch = supabase.channel(channelName(session_id), {
        config: { broadcast: { self: true } },
      });
      channelRef.current = ch;

      ch.on("broadcast", { event: "pos_sim" }, (msg: BroadcastMessage) => {
        const evUnknown = msg.payload;
        if (!isPosSimEvent(evUnknown)) return;

        // Host is authoritative: if customer joins, re-send snapshot
        if (evUnknown.type === "CUSTOMER_JOINED") {
          const sid = sessionIdRef.current;
          const snap = snapshotRef.current;
          if (!sid || !snap) return;

          const snapEv = makeEvent("SNAPSHOT_SYNC", sid, snapshotPayload(snap));
          void safeSend(ch, snapEv);
        }
      });

      ch.subscribe(async (st: SubscribeStatus) => {
        if (st === "SUBSCRIBED") {
          setHostStatus("Live");

          const createdEv = makeEvent("SESSION_CREATED", session_id, {
            session_code,
            customer_url,
          } as unknown as JsonObject);

          const snapEv = makeEvent(
            "SNAPSHOT_SYNC",
            session_id,
            snapshotPayload(snapshot)
          );

          await safeSend(ch, createdEv);
          await safeSend(ch, snapEv);
          return;
        }

        if (st === "TIMED_OUT") setHostStatus("Realtime timed out");
        if (st === "CHANNEL_ERROR") setHostStatus("Realtime channel error");
        if (st === "CLOSED") setHostStatus("Realtime closed");
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("Start session failed:", e);
      setHostStatus(`Error: ${message}`);
      alert(message);
    } finally {
      setCreating(false);
    }
  }

  function addItem(ci: CatalogItem) {
    if (!session) return;
    const snap = getSnap();
    if (!snap) return;

    // block edits during processing/result for realism (optional)
    if (snap.flow.stage === "PROCESSING") return;

    const items = [...(snap.cart.items ?? [])];
    const existing = items.find((i) => i.sku === ci.sku);

    if (existing) {
      existing.qty += 1;
      existing.line_total = round2(existing.qty * existing.unit_price);
      const rate = existing.vat_rate ?? ci.vat_rate;
      existing.vat_rate = rate;
      existing.vat_amount = round2(existing.line_total * rate);
    } else {
      const line_no = nextLineNo(items);
      const line_total = round2(ci.price);
      const vat_amount = round2(line_total * ci.vat_rate);

      items.push({
        line_no,
        sku: ci.sku,
        name: ci.name,
        qty: 1,
        unit_price: ci.price,
        line_total,
        vat_rate: ci.vat_rate,
        vat_amount,
      });
    }

    const totals = recalcCart(items);

    const nextSnap: PosSimSnapshot = {
      ...snap,
      flow: { ...snap.flow, stage: "CART" },
      cart: {
        currency: snap.cart.currency ?? "EUR",
        items,
        ...totals,
      },
    };

    void persistAndBroadcast(nextSnap);
  }

  function decItem(line_no: number) {
    if (!session) return;
    const snap = getSnap();
    if (!snap) return;

    if (snap.flow.stage === "PROCESSING") return;

    const items = [...(snap.cart.items ?? [])];

    const idx = items.findIndex((i) => i.line_no === line_no);
    if (idx < 0) return;

    const it = items[idx];
    it.qty -= 1;

    if (it.qty <= 0) {
      items.splice(idx, 1);
    } else {
      it.line_total = round2(it.qty * it.unit_price);
      const rate = it.vat_rate ?? 0;
      it.vat_amount = round2(it.line_total * rate);
    }

    const totals = recalcCart(items);
    const nextSnap: PosSimSnapshot = {
      ...snap,
      cart: { currency: snap.cart.currency ?? "EUR", items, ...totals },
    };

    void persistAndBroadcast(nextSnap);
  }

  function incItem(line_no: number) {
    if (!session) return;
    const snap = getSnap();
    if (!snap) return;

    if (snap.flow.stage === "PROCESSING") return;

    const items = [...(snap.cart.items ?? [])];

    const it = items.find((i) => i.line_no === line_no);
    if (!it) return;

    it.qty += 1;
    it.line_total = round2(it.qty * it.unit_price);
    const rate = it.vat_rate ?? 0;
    it.vat_amount = round2(it.line_total * rate);

    const totals = recalcCart(items);
    const nextSnap: PosSimSnapshot = {
      ...snap,
      cart: { currency: snap.cart.currency ?? "EUR", items, ...totals },
    };

    void persistAndBroadcast(nextSnap);
  }

  function clearCart() {
    if (!session) return;
    const snap = getSnap();
    if (!snap) return;

    if (snap.flow.stage === "PROCESSING") return;

    const nextSnap: PosSimSnapshot = {
      ...snap,
      flow: { ...snap.flow, stage: "CART", payment_state: "IDLE" },
      cart: {
        currency: snap.cart.currency ?? "EUR",
        items: [],
        subtotal: 0,
        vat_total: 0,
        total: 0,
      },
    };

    void persistAndBroadcast(nextSnap);
  }

  function updateToggle<K extends keyof PosSimSnapshot["toggles"]>(
    key: K,
    value: PosSimSnapshot["toggles"][K]
  ) {
    const snap = getSnap();
    if (!snap) return;

    const nextSnap: PosSimSnapshot = {
      ...snap,
      toggles: { ...snap.toggles, [key]: value },
    };

    void persistAndBroadcast(nextSnap);
  }

  function goToCheckout() {
    const snap = getSnap();
    if (!snap) return;

    if (cartIsEmpty(snap)) {
      setHostStatus("Add items before checkout");
      return;
    }

    const nextSnap: PosSimSnapshot = {
      ...snap,
      flow: { ...snap.flow, stage: "CHECKOUT", payment_state: "INITIATED" },
    };

    setHostStatus("Checkout initiated");
    void persistAndBroadcast(nextSnap);
  }

  function backToCart() {
    const snap = getSnap();
    if (!snap) return;

    // If in PROCESSING, block back for realism
    if (snap.flow.stage === "PROCESSING") return;

    const nextSnap: PosSimSnapshot = {
      ...snap,
      flow: { ...snap.flow, stage: "CART", payment_state: "IDLE" },
    };

    setHostStatus("Back to cart");
    void persistAndBroadcast(nextSnap);
  }

  function newSale() {
    const snap = getSnap();
    if (!snap) return;

    if (payTimerRef.current) {
      window.clearTimeout(payTimerRef.current);
      payTimerRef.current = null;
    }

    const nextSnap: PosSimSnapshot = {
      ...snap,
      active_sale_id: newSaleId(),
      flow: { stage: "CART", payment_state: "IDLE", issuance_state: "IDLE" },
      receipt: null,
      fallback: { printed: false, print_reason: null },
      cart: {
        currency: snap.cart.currency ?? "EUR",
        items: [],
        subtotal: 0,
        vat_total: 0,
        total: 0,
      },
    };

    setHostStatus("New sale started");
    void persistAndBroadcast(nextSnap);
  }

  function pay() {
    const snap = getSnap();
    if (!snap) return;

    if (cartIsEmpty(snap)) {
      setHostStatus("Cannot pay: cart is empty");
      return;
    }

    if (snap.flow.stage !== "CHECKOUT" && snap.flow.stage !== "CART") {
      // allow pay only from checkout for cleanliness
      setHostStatus("Go to checkout first");
      return;
    }

    // Cancel any pending timer
    if (payTimerRef.current) {
      window.clearTimeout(payTimerRef.current);
      payTimerRef.current = null;
    }

    // Immediate NETWORK_ERROR if network is down
    if (snap.toggles.network_mode === "down") {
      const nextSnap: PosSimSnapshot = {
        ...snap,
        flow: { ...snap.flow, stage: "RESULT", payment_state: "NETWORK_ERROR" },
      };
      setHostStatus("Network down (simulated)");
      void persistAndBroadcast(nextSnap);
      return;
    }

    // Move to processing
    const processingSnap: PosSimSnapshot = {
      ...snap,
      flow: { ...snap.flow, stage: "PROCESSING", payment_state: "PROCESSING" },
    };
    setHostStatus("Processing payment...");
    void persistAndBroadcast(processingSnap);

    const slow = snap.toggles.network_mode === "slow";

    // Determine delay + final outcome
    const baseDelay = slow ? 3500 : 1500;

    // Timeout should feel longer
    const delay =
      snap.toggles.payment_outcome === "timeout"
        ? slow
          ? 9000
          : 7000
        : baseDelay;

    payTimerRef.current = window.setTimeout(() => {
      const latest = getSnap();
      if (!latest) return;

      // If user started a new sale mid-flight, ignore
      if (latest.flow.stage !== "PROCESSING") return;

      let finalState: PosSimSnapshot["flow"]["payment_state"] = "APPROVED";

      if (latest.toggles.payment_outcome === "fail") finalState = "DECLINED";
      if (latest.toggles.payment_outcome === "timeout") finalState = "TIMEOUT";

      const resultSnap: PosSimSnapshot = {
        ...latest,
        flow: { ...latest.flow, stage: "RESULT", payment_state: finalState },
      };

      setHostStatus(
        finalState === "APPROVED"
          ? "Payment approved"
          : finalState === "DECLINED"
          ? "Payment declined"
          : "Payment timed out"
      );

      void persistAndBroadcast(resultSnap);
    }, delay);
  }

  if (!POS_SIM_ENABLED) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>POS Simulator</h1>
        <p style={{ marginTop: 8 }}>
          Not enabled. Set NEXT_PUBLIC_POS_SIM_ENABLED=true.
        </p>
      </div>
    );
  }

  const snap = session?.snapshot ?? null;

  const stage = snap?.flow.stage ?? "BOOT";
  const payState = snap?.flow.payment_state ?? "IDLE";

  return (
    <div style={{ padding: 24, maxWidth: 1040 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800 }}>
        Receiptless POS Simulator — Web POS (A3)
      </h1>
      <p style={{ marginTop: 8 }}>
        Milestone A3: Checkout + payment outcomes (success/fail/timeout +
        network modes).
      </p>

      <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
        Host Status: <b>{hostStatus}</b>
      </div>

      {!session ? (
        <div style={{ marginTop: 20 }}>
          <button
            onClick={startSession}
            disabled={creating}
            style={{
              padding: "12px 16px",
              borderRadius: 10,
              border: "1px solid #ccc",
              fontWeight: 800,
            }}
          >
            {creating ? "Creating Session..." : "Start Demo Session"}
          </button>

          <div style={{ marginTop: 14, fontSize: 13, opacity: 0.8 }}>
            Demo terminal: <b>{DEMO_TERMINAL_CODE}</b> — Store:{" "}
            <b>{DEMO_STORE_ID}</b>
          </div>
        </div>
      ) : (
        <div
          style={{ marginTop: 18, display: "flex", gap: 16, flexWrap: "wrap" }}
        >
          {/* Left column: session + toggles + catalog */}
          <div
            style={{
              flex: 1,
              minWidth: 340,
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Session Code</div>
                <div
                  style={{ fontSize: 26, fontWeight: 900, letterSpacing: 2 }}
                >
                  {session.session_code}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Stage</div>
                <div style={{ fontWeight: 900 }}>{stage}</div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                  Payment
                </div>
                <div style={{ fontWeight: 900 }}>{payState}</div>
              </div>
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
              Customer Display
            </div>
            <a href={session.customer_url} target="_blank" rel="noreferrer">
              Open Customer Display
            </a>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
              Full URL
            </div>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: 12,
                wordBreak: "break-all",
              }}
            >
              {customerFullUrl}
            </div>

            <hr style={{ margin: "14px 0" }} />

            {/* Toggles */}
            <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 8 }}>
              Demo Toggles
            </div>

            <div style={{ display: "grid", gap: 10 }}>
              <label style={{ display: "grid", gap: 6 }}>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  Payment Outcome
                </div>
                <select
                  value={snap?.toggles.payment_outcome ?? "success"}
                  onChange={(e) =>
                    updateToggle(
                      "payment_outcome",
                      e.target.value as "success" | "fail" | "timeout"
                    )
                  }
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: "1px solid #ccc",
                  }}
                >
                  <option value="success">Success</option>
                  <option value="fail">Fail</option>
                  <option value="timeout">Timeout</option>
                </select>
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <div style={{ fontSize: 12, opacity: 0.8 }}>Network Mode</div>
                <select
                  value={snap?.toggles.network_mode ?? "normal"}
                  onChange={(e) =>
                    updateToggle(
                      "network_mode",
                      e.target.value as "normal" | "slow" | "down"
                    )
                  }
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: "1px solid #ccc",
                  }}
                >
                  <option value="normal">Normal</option>
                  <option value="slow">Slow</option>
                  <option value="down">Down</option>
                </select>
              </label>
            </div>

            <hr style={{ margin: "14px 0" }} />

            {/* Catalog */}
            <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 8 }}>
              Demo Catalog
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {CATALOG.map((ci) => (
                <button
                  key={ci.sku}
                  onClick={() => addItem(ci)}
                  disabled={stage === "PROCESSING"}
                  style={{
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid #ccc",
                    background: "white",
                    opacity: stage === "PROCESSING" ? 0.6 : 1,
                  }}
                >
                  <div style={{ fontWeight: 800 }}>{ci.name}</div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    {ci.sku} — EUR {ci.price.toFixed(2)} — VAT{" "}
                    {(ci.vat_rate * 100).toFixed(0)}%
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Right column: cart + actions */}
          <div
            style={{
              flex: 1.4,
              minWidth: 520,
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                alignItems: "baseline",
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 900 }}>Cart</div>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                }}
              >
                <button
                  onClick={newSale}
                  style={{
                    border: "1px solid #ccc",
                    borderRadius: 10,
                    padding: "8px 10px",
                    background: "white",
                    fontWeight: 800,
                  }}
                >
                  New Sale
                </button>
                <button
                  onClick={clearCart}
                  disabled={stage === "PROCESSING"}
                  style={{
                    border: "1px solid #ccc",
                    borderRadius: 10,
                    padding: "8px 10px",
                    background: "white",
                    opacity: stage === "PROCESSING" ? 0.6 : 1,
                  }}
                >
                  Clear
                </button>
              </div>
            </div>

            {/* Action bar */}
            <div
              style={{
                marginTop: 12,
                display: "flex",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <button
                onClick={backToCart}
                disabled={stage === "PROCESSING" || stage === "CART"}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #ccc",
                  background: "white",
                  fontWeight: 800,
                  opacity: stage === "PROCESSING" || stage === "CART" ? 0.6 : 1,
                }}
              >
                Back to Cart
              </button>

              <button
                onClick={goToCheckout}
                disabled={!snap || cartIsEmpty(snap) || stage === "PROCESSING"}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #ccc",
                  background: "white",
                  fontWeight: 900,
                  opacity:
                    !snap || cartIsEmpty(snap) || stage === "PROCESSING"
                      ? 0.6
                      : 1,
                }}
              >
                Checkout
              </button>

              <button
                onClick={pay}
                disabled={!snap || cartIsEmpty(snap) || stage === "PROCESSING"}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #111",
                  background: "#111",
                  color: "white",
                  fontWeight: 900,
                  opacity:
                    !snap || cartIsEmpty(snap) || stage === "PROCESSING"
                      ? 0.6
                      : 1,
                }}
              >
                Pay
              </button>
            </div>

            {/* Cart list */}
            <div style={{ marginTop: 14 }}>
              {(session.snapshot.cart.items ?? []).length === 0 ? (
                <div style={{ fontSize: 13, opacity: 0.8 }}>Cart is empty.</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {(session.snapshot.cart.items ?? []).map((it) => (
                    <div
                      key={it.line_no}
                      style={{
                        border: "1px solid #eee",
                        borderRadius: 10,
                        padding: 10,
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 10,
                        alignItems: "center",
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 800 }}>{it.name}</div>
                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                          {it.sku ?? "—"} — EUR{" "}
                          {Number(it.unit_price).toFixed(2)}
                        </div>
                      </div>

                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <button
                          onClick={() => decItem(it.line_no)}
                          disabled={stage === "PROCESSING"}
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: 10,
                            border: "1px solid #ccc",
                            background: "white",
                            opacity: stage === "PROCESSING" ? 0.6 : 1,
                          }}
                        >
                          −
                        </button>
                        <div
                          style={{
                            minWidth: 28,
                            textAlign: "center",
                            fontWeight: 900,
                          }}
                        >
                          {it.qty}
                        </div>
                        <button
                          onClick={() => incItem(it.line_no)}
                          disabled={stage === "PROCESSING"}
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: 10,
                            border: "1px solid #ccc",
                            background: "white",
                            opacity: stage === "PROCESSING" ? 0.6 : 1,
                          }}
                        >
                          +
                        </button>
                      </div>

                      <div style={{ fontFamily: "monospace", fontWeight: 900 }}>
                        EUR {Number(it.line_total ?? 0).toFixed(2)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Totals */}
            <div
              style={{
                marginTop: 14,
                borderTop: "1px solid #eee",
                paddingTop: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div style={{ opacity: 0.8 }}>Subtotal</div>
                <div style={{ fontWeight: 800 }}>
                  EUR {Number(session.snapshot.cart.subtotal ?? 0).toFixed(2)}
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginTop: 6,
                }}
              >
                <div style={{ opacity: 0.8 }}>VAT</div>
                <div style={{ fontWeight: 800 }}>
                  EUR {Number(session.snapshot.cart.vat_total ?? 0).toFixed(2)}
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginTop: 10,
                  fontSize: 18,
                }}
              >
                <div style={{ fontWeight: 900 }}>Total</div>
                <div style={{ fontWeight: 900 }}>
                  EUR {Number(session.snapshot.cart.total ?? 0).toFixed(2)}
                </div>
              </div>
            </div>

            {/* Result hint */}
            {stage === "RESULT" && (
              <div
                style={{
                  marginTop: 14,
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid #eee",
                  background: "white",
                }}
              >
                <div style={{ fontWeight: 900 }}>Payment Result</div>
                <div style={{ marginTop: 6, opacity: 0.85 }}>
                  {payState === "APPROVED" &&
                    "Approved — next milestone will issue the real receipt token."}
                  {payState === "DECLINED" &&
                    "Declined — adjust outcome toggle or try again."}
                  {payState === "TIMEOUT" &&
                    "Timeout — adjust outcome toggle or try again."}
                  {payState === "NETWORK_ERROR" &&
                    "Network error — set Network Mode back to Normal/Slow."}
                </div>
              </div>
            )}

            {/* Debug */}
            <div style={{ marginTop: 14, fontSize: 12, opacity: 0.7 }}>
              Snapshot (debug)
            </div>
            <pre
              style={{
                marginTop: 6,
                fontSize: 12,
                maxHeight: 220,
                overflow: "auto",
              }}
            >
              {JSON.stringify(session.snapshot, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
