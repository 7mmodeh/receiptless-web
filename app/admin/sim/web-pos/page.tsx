// app/admin/sim/web-pos/page.tsx
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
  PosSimDbEvent,
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
  try {
    return crypto.randomUUID();
  } catch {
    return `sale_${Date.now()}`;
  }
}

function cartIsEmpty(snap: PosSimSnapshot) {
  return (
    (snap.cart.items ?? []).length === 0 || Number(snap.cart.total ?? 0) <= 0
  );
}

function fmtTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function shortJson(v: unknown) {
  try {
    const s = JSON.stringify(v);
    return s.length > 160 ? s.slice(0, 160) + "…" : s;
  } catch {
    return String(v);
  }
}

// Remove undefined values (jsonb cannot store undefined, and supabase can choke on it)
function stripUndefined(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripUndefined);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return obj;
}

export default function WebPosSimPageA4() {
  const supabase = useMemo(() => getSupabaseClient(), []);

  const [creating, setCreating] = useState(false);
  const [hostStatus, setHostStatus] = useState<string>("Idle");
  const [session, setSession] = useState<{
    session_id: string;
    session_code: string;
    customer_url: string;
    snapshot: PosSimSnapshot;
  } | null>(null);

  // Durable timeline
  const [timeline, setTimeline] = useState<PosSimDbEvent[]>([]);
  const [timelineWriteStatus, setTimelineWriteStatus] = useState<string>("—");
  const timelineChRef = useRef<RealtimeChannel | null>(null);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const snapshotRef = useRef<PosSimSnapshot | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const payTimerRef = useRef<number | null>(null);
  const issuingRef = useRef(false);

  const customerFullUrl = useMemo(() => {
    if (!session) return "";
    if (typeof window === "undefined") return session.customer_url;
    return `${window.location.origin}${session.customer_url}`;
  }, [session]);

  function getSnap(): PosSimSnapshot | null {
    return snapshotRef.current ?? session?.snapshot ?? null;
  }

  useEffect(() => {
    return () => {
      const ch = channelRef.current;
      channelRef.current = null;
      if (ch) supabase.removeChannel(ch);

      const tch = timelineChRef.current;
      timelineChRef.current = null;
      if (tch) supabase.removeChannel(tch);

      if (payTimerRef.current) {
        window.clearTimeout(payTimerRef.current);
        payTimerRef.current = null;
      }
    };
  }, [supabase]);

  async function logDbEvent(event_type: string, payload: JsonObject) {
    const sid = sessionIdRef.current;
    if (!sid) return;

    setTimelineWriteStatus("writing…");

    const safePayload = stripUndefined(payload) as JsonObject;

    const { data, error } = await supabase
      .from("pos_sim_events")
      .insert([{ session_id: sid, event_type, payload: safePayload }])
      .select("id, session_id, event_type, payload, created_at")
      .single();

    if (error) {
      setTimelineWriteStatus(`FAILED: ${error.message}`);
      console.error("pos_sim_events insert failed:", error);
      // This is why you were seeing 0 events — now it will be visible.
      return;
    }

    setTimelineWriteStatus("ok");

    const inserted = data as unknown as PosSimDbEvent | null;
    if (!inserted) return;

    setTimeline((prev) => {
      if (prev.some((e) => e.id === inserted.id)) return prev;
      return [...prev, inserted];
    });
  }

  async function loadTimelineAndSubscribe(sessionId: string) {
    // Load history
    const { data, error } = await supabase
      .from("pos_sim_events")
      .select("id, session_id, event_type, payload, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(400);

    if (error) {
      setTimelineWriteStatus(`read FAILED: ${error.message}`);
    } else if (Array.isArray(data)) {
      setTimeline(data as unknown as PosSimDbEvent[]);
      setTimelineWriteStatus("read ok");
    }

    // Subscribe to inserts (requires Supabase Realtime enabled for table)
    if (timelineChRef.current) {
      supabase.removeChannel(timelineChRef.current);
      timelineChRef.current = null;
    }

    const tch = supabase.channel(`pos-sim-events:${sessionId}`);
    timelineChRef.current = tch;

    tch.on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "pos_sim_events",
        filter: `session_id=eq.${sessionId}`,
      },
      (payload) => {
        const row = payload.new as unknown as PosSimDbEvent;
        setTimeline((prev) => {
          if (prev.some((e) => e.id === row.id)) return prev;
          return [...prev, row];
        });
      }
    );

    tch.subscribe((st) => {
      // If this table is not enabled for realtime, you will not get inserts here.
      // History will still show if inserts work.
      if (st === "CHANNEL_ERROR") {
        setTimelineWriteStatus((s) => `${s} | realtime CHANNEL_ERROR`);
      }
    });
  }

  async function persistSnapshot(nextSnap: PosSimSnapshot) {
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

    const snapEv = makeEvent("SNAPSHOT_SYNC", sid, snapshotPayload(nextSnap));
    await safeSend(ch, snapEv);
  }

  async function persistAndBroadcast(
    nextSnap: PosSimSnapshot,
    event_type?: string,
    event_payload?: JsonObject
  ) {
    await persistSnapshot(nextSnap);

    if (event_type) {
      await logDbEvent(event_type, event_payload ?? ({} as JsonObject));
    }
  }

  function canAutoFallbackPrint(snap: PosSimSnapshot) {
    return (
      snap.toggles.print_fallback === "enabled" &&
      snap.flow.payment_state === "APPROVED" &&
      !snap.fallback.printed
    );
  }

  async function fallbackPrint(
    reason: "NETWORK" | "ISSUANCE_FAIL" | "CUSTOMER_REQUEST" | "SCAN_FAIL"
  ) {
    const snap = getSnap();
    if (!snap) return;

    if (!canAutoFallbackPrint(snap)) {
      setHostStatus(
        "Fallback print not allowed (toggle disabled / not approved / already printed)"
      );
      return;
    }

    const nextSnap: PosSimSnapshot = {
      ...snap,
      fallback: { printed: true, print_reason: reason },
      flow: { ...snap.flow, issuance_state: "FALLBACK_PRINTED" },
    };

    setHostStatus(`Printed paper receipt (${reason})`);
    await persistAndBroadcast(nextSnap, "FALLBACK_PRINTED", {
      reason,
    } as unknown as JsonObject);
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

      await loadTimelineAndSubscribe(session_id);

      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }

      setHostStatus("Connecting realtime...");

      const ch = supabase.channel(channelName(session_id), {
        config: { broadcast: { self: true } },
      });
      channelRef.current = ch;

      ch.on(
        "broadcast",
        { event: "pos_sim" },
        async (msg: BroadcastMessage) => {
          const evUnknown = msg.payload;
          if (!isPosSimEvent(evUnknown)) return;

          if (evUnknown.type === "CUSTOMER_JOINED") {
            const sid = sessionIdRef.current;
            const snap = snapshotRef.current;
            if (!sid || !snap) return;

            await logDbEvent("CUSTOMER_JOINED", {
              session_code,
            } as unknown as JsonObject);

            const snapEv = makeEvent(
              "SNAPSHOT_SYNC",
              sid,
              snapshotPayload(snap)
            );
            void safeSend(ch, snapEv);
          }

          if (evUnknown.type === "CUSTOMER_SCANNED") {
            const sid = sessionIdRef.current;
            const snap = snapshotRef.current;
            if (!sid || !snap) return;

            const p = evUnknown.payload as Record<string, unknown>;
            const outcome = (p.outcome === "success" ? "SUCCESS" : "FAIL") as
              | "SUCCESS"
              | "FAIL";
            const message =
              typeof p.message === "string"
                ? p.message
                : outcome === "SUCCESS"
                ? "Receipt linked to wallet (simulated)."
                : "Scan failed (simulated).";

            const nextSnap: PosSimSnapshot = {
              ...snap,
              scan: {
                state: outcome,
                scanned_at: new Date().toISOString(),
                message,
              },
            };

            setHostStatus(
              outcome === "SUCCESS"
                ? "Customer scan success"
                : "Customer scan failed"
            );

            await persistAndBroadcast(nextSnap, "CUSTOMER_SCANNED", {
              outcome: outcome === "SUCCESS" ? "success" : "fail",
              message,
            } as unknown as JsonObject);

            // Rule #2: payment success + scan fail => fallback print
            if (outcome === "FAIL" && canAutoFallbackPrint(nextSnap)) {
              await fallbackPrint("SCAN_FAIL");
            }
          }
        }
      );

      ch.subscribe(async (st: SubscribeStatus) => {
        if (st === "SUBSCRIBED") {
          setHostStatus("Live");

          await logDbEvent("SESSION_CREATED", {
            session_code,
            customer_url,
            mode: "web_pos",
          } as unknown as JsonObject);

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

    void persistAndBroadcast(nextSnap, "CART_UPDATED", {
      items_count: items.length,
      total: totals.total,
    } as unknown as JsonObject);
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

    void persistAndBroadcast(nextSnap, "CART_UPDATED", {
      items_count: items.length,
      total: totals.total,
    } as unknown as JsonObject);
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

    void persistAndBroadcast(nextSnap, "CART_UPDATED", {
      items_count: items.length,
      total: totals.total,
    } as unknown as JsonObject);
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
      scan: { state: "NONE" },
      fallback: { printed: false, print_reason: null },
      receipt: null,
    };

    void persistAndBroadcast(nextSnap, "CART_CLEARED", {} as JsonObject);
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

    void persistAndBroadcast(nextSnap, "SNAPSHOT_SYNC", {
      toggle: String(key),
      value: String(value),
    } as unknown as JsonObject);
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
      scan: { state: "NONE" },
      fallback: { printed: false, print_reason: null },
    };

    setHostStatus("Checkout initiated");
    void persistAndBroadcast(nextSnap, "CHECKOUT_INITIATED", {
      total: Number(nextSnap.cart.total ?? 0),
      currency: nextSnap.cart.currency ?? "EUR",
    } as unknown as JsonObject);
  }

  function backToCart() {
    const snap = getSnap();
    if (!snap) return;
    if (snap.flow.stage === "PROCESSING") return;

    const nextSnap: PosSimSnapshot = {
      ...snap,
      flow: { ...snap.flow, stage: "CART", payment_state: "IDLE" },
    };

    setHostStatus("Back to cart");
    void persistAndBroadcast(nextSnap, "SNAPSHOT_SYNC", {
      stage: "CART",
    } as unknown as JsonObject);
  }

  function newSale() {
    const snap = getSnap();
    if (!snap) return;

    issuingRef.current = false;

    if (payTimerRef.current) {
      window.clearTimeout(payTimerRef.current);
      payTimerRef.current = null;
    }

    const nextSnap: PosSimSnapshot = {
      ...snap,
      active_sale_id: newSaleId(),
      flow: { stage: "CART", payment_state: "IDLE", issuance_state: "IDLE" },
      receipt: null,
      scan: { state: "NONE" },
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
    void persistAndBroadcast(nextSnap, "NEW_SALE_STARTED", {
      sale_id: nextSnap.active_sale_id ?? null,
    } as unknown as JsonObject);
  }

  function pay() {
    const snap = getSnap();
    if (!snap) return;

    if (cartIsEmpty(snap)) {
      setHostStatus("Cannot pay: cart is empty");
      return;
    }

    if (snap.flow.stage !== "CHECKOUT" && snap.flow.stage !== "CART") {
      setHostStatus("Go to checkout first");
      return;
    }

    if (payTimerRef.current) {
      window.clearTimeout(payTimerRef.current);
      payTimerRef.current = null;
    }

    issuingRef.current = false;

    if (snap.toggles.network_mode === "down") {
      const nextSnap: PosSimSnapshot = {
        ...snap,
        flow: { ...snap.flow, stage: "RESULT", payment_state: "NETWORK_ERROR" },
      };
      setHostStatus("Network down (simulated)");
      void persistAndBroadcast(nextSnap, "PAYMENT_RESULT", {
        state: "NETWORK_ERROR",
      } as unknown as JsonObject);

      // Rule #2: network fail -> fallback print (if payment was already approved; in this branch it isn't)
      // Here, payment never approved; so we do NOT print.
      return;
    }

    const processingSnap: PosSimSnapshot = {
      ...snap,
      receipt: null,
      scan: { state: "NONE" },
      fallback: { printed: false, print_reason: null },
      flow: {
        ...snap.flow,
        stage: "PROCESSING",
        payment_state: "PROCESSING",
        issuance_state: "IDLE",
      },
    };

    setHostStatus("Processing payment...");
    void persistAndBroadcast(processingSnap, "PAYMENT_PROCESSING", {
      total: Number(processingSnap.cart.total ?? 0),
      currency: processingSnap.cart.currency ?? "EUR",
    } as unknown as JsonObject);

    const slow = snap.toggles.network_mode === "slow";
    const baseDelay = slow ? 3500 : 1500;
    const delay =
      snap.toggles.payment_outcome === "timeout"
        ? slow
          ? 9000
          : 7000
        : baseDelay;

    payTimerRef.current = window.setTimeout(() => {
      const latest = getSnap();
      if (!latest) return;
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

      void persistAndBroadcast(resultSnap, "PAYMENT_RESULT", {
        state: finalState,
      } as unknown as JsonObject);

      // If you ever decide "timeout but money taken" => approved, that logic would go here.
    }, delay);
  }

  async function issueReceipt() {
    const snap = getSnap();
    if (!snap) return;

    if (snap.flow.payment_state !== "APPROVED") {
      setHostStatus("Receipt issuance requires APPROVED payment");
      return;
    }

    if (snap.flow.issuance_state === "INGESTING") return;
    if (issuingRef.current) return;

    issuingRef.current = true;

    const ingestingSnap: PosSimSnapshot = {
      ...snap,
      flow: { ...snap.flow, issuance_state: "INGESTING" },
      receipt: null,
    };

    setHostStatus("Issuing receipt (real receipt-ingest)...");
    await persistAndBroadcast(ingestingSnap, "RECEIPT_ISSUANCE_STARTED", {
      sale_id: ingestingSnap.active_sale_id ?? null,
    } as unknown as JsonObject);

    const payload = {
      retailer_id: snap.terminal.retailer_id,
      store_id: snap.terminal.store_id,
      terminal_code: snap.terminal.terminal_code,

      issued_at: new Date().toISOString(),
      receipt_number: null,

      currency: snap.cart.currency ?? "EUR",
      subtotal: Number(snap.cart.subtotal ?? 0),
      vat_total: Number(snap.cart.vat_total ?? 0),
      total: Number(snap.cart.total ?? 0),

      items: (snap.cart.items ?? []).map((i) => ({
        line_no: i.line_no,
        sku: i.sku ?? null,
        name: i.name,
        qty: Number(i.qty),
        unit_price: Number(i.unit_price),
        line_total: Number(i.line_total),
        vat_rate: i.vat_rate ?? null,
        vat_amount: i.vat_amount ?? null,
      })),
    };

    try {
      const res = await fetch("/api/pos-sim/issue-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const out = (await res.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;

      if (!res.ok) {
        const details = out?.details ?? out ?? { status: res.status };
        throw new Error(
          typeof details === "string" ? details : JSON.stringify(details)
        );
      }

      const token_id = typeof out?.token_id === "string" ? out.token_id : null;
      const public_url =
        typeof out?.public_url === "string" ? out.public_url : null;
      const qr_url = typeof out?.qr_url === "string" ? out.qr_url : public_url;
      const preview_url =
        typeof out?.preview_url === "string" || out?.preview_url === null
          ? (out.preview_url as string | null)
          : null;

      if (!token_id || !public_url)
        throw new Error("Invalid receipt-ingest response shape");

      const base = getSnap()!;
      const nextSnap: PosSimSnapshot = {
        ...base,
        flow: { ...base.flow, issuance_state: "TOKEN_READY" },
        receipt: {
          token_id,
          public_url,
          qr_url: qr_url ?? public_url,
          preview_url,
        },
        scan: { state: "PENDING" },
      };

      setHostStatus("Receipt token ready");
      await persistAndBroadcast(nextSnap, "RECEIPT_TOKEN_READY", {
        token_id,
        public_url,
      } as unknown as JsonObject);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);

      const base = getSnap()!;
      const failedSnap: PosSimSnapshot = {
        ...base,
        flow: { ...base.flow, issuance_state: "FAILED" },
      };

      setHostStatus(`Receipt issuance failed: ${msg}`);
      await persistAndBroadcast(failedSnap, "RECEIPT_ISSUANCE_FAILED", {
        message: msg,
      } as unknown as JsonObject);

      // Rule #2: payment success + issuance fail => fallback print
      if (canAutoFallbackPrint(failedSnap)) {
        await fallbackPrint("ISSUANCE_FAIL");
      }
    } finally {
      issuingRef.current = false;
    }
  }

  // Auto-issue receipt once when payment is approved
  useEffect(() => {
    const snap = getSnap();
    if (!snap) return;

    const shouldAuto =
      snap.flow.stage === "RESULT" &&
      snap.flow.payment_state === "APPROVED" &&
      snap.flow.issuance_state === "IDLE" &&
      !snap.receipt;

    if (!shouldAuto) return;

    void issueReceipt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    session?.snapshot?.flow?.stage,
    session?.snapshot?.flow?.payment_state,
    session?.snapshot?.flow?.issuance_state,
  ]);

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
  const issuanceState = snap?.flow.issuance_state ?? "IDLE";
  const scanState = snap?.scan?.state ?? "—";

  const showPrintButton =
    !!snap &&
    snap.flow.payment_state === "APPROVED" &&
    snap.toggles.print_fallback === "enabled" &&
    !snap.fallback.printed;

  return (
    <div style={{ padding: 24, maxWidth: 1240 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800 }}>
        Receiptless POS Simulator — Web POS (A4)
      </h1>
      <p style={{ marginTop: 8 }}>
        Canonical: <b>pos_sim_sessions.snapshot_json</b>. Durable timeline:{" "}
        <b>pos_sim_events</b>. Broadcast stays for instant sync.
      </p>

      <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
        Host Status: <b>{hostStatus}</b>
        <span style={{ marginLeft: 10, opacity: 0.8 }}>
          Timeline: <b>{timelineWriteStatus}</b>
        </span>
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
          style={{
            marginTop: 18,
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          {/* Left column */}
          <div
            style={{
              flex: 1,
              minWidth: 360,
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
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                  Issuance
                </div>
                <div style={{ fontWeight: 900 }}>{issuanceState}</div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                  Scan
                </div>
                <div style={{ fontWeight: 900 }}>{scanState}</div>
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

              <label style={{ display: "grid", gap: 6 }}>
                <div style={{ fontSize: 12, opacity: 0.8 }}>Print Fallback</div>
                <select
                  value={snap?.toggles.print_fallback ?? "enabled"}
                  onChange={(e) =>
                    updateToggle(
                      "print_fallback",
                      e.target.value as "enabled" | "disabled"
                    )
                  }
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: "1px solid #ccc",
                  }}
                >
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  Customer Scan Sim
                </div>
                <select
                  value={snap?.toggles.customer_scan_sim ?? "none"}
                  onChange={(e) =>
                    updateToggle(
                      "customer_scan_sim",
                      e.target.value as "none" | "auto_success" | "auto_fail"
                    )
                  }
                  style={{
                    padding: 10,
                    borderRadius: 10,
                    border: "1px solid #ccc",
                  }}
                >
                  <option value="none">None</option>
                  <option value="auto_success">Auto Success</option>
                  <option value="auto_fail">Auto Fail</option>
                </select>
              </label>
            </div>

            <hr style={{ margin: "14px 0" }} />

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

          {/* Right column */}
          <div
            style={{
              flex: 1.5,
              minWidth: 560,
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

              <button
                onClick={issueReceipt}
                disabled={
                  !snap ||
                  payState !== "APPROVED" ||
                  issuanceState === "INGESTING" ||
                  issuanceState === "TOKEN_READY"
                }
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #0a7",
                  background: "white",
                  fontWeight: 900,
                  opacity:
                    !snap ||
                    payState !== "APPROVED" ||
                    issuanceState === "INGESTING" ||
                    issuanceState === "TOKEN_READY"
                      ? 0.6
                      : 1,
                }}
              >
                {issuanceState === "INGESTING"
                  ? "Issuing..."
                  : "Issue Receipt (Real)"}
              </button>

              {/* Rule #1: print button after pay success */}
              <button
                onClick={() => void fallbackPrint("CUSTOMER_REQUEST")}
                disabled={!showPrintButton}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #555",
                  background: "white",
                  fontWeight: 900,
                  opacity: showPrintButton ? 1 : 0.6,
                }}
                title="Print paper receipt on POS terminal (simulated)"
              >
                Print Paper Receipt
              </button>
            </div>

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

            <div style={{ marginTop: 14 }}>
              <div style={{ fontWeight: 900 }}>Receipt</div>

              {/* Fallback state visibility */}
              {snap?.fallback?.printed ? (
                <div style={{ marginTop: 6, opacity: 0.9 }}>
                  <b>Paper receipt printed</b> — reason:{" "}
                  <b>{snap.fallback.print_reason ?? "—"}</b>
                </div>
              ) : (
                <div style={{ marginTop: 6, opacity: 0.75 }}>
                  Paper receipt not printed.
                </div>
              )}

              {issuanceState === "IDLE" && (
                <div style={{ opacity: 0.8, marginTop: 6 }}>
                  Not issued yet.
                </div>
              )}
              {issuanceState === "INGESTING" && (
                <div style={{ opacity: 0.8, marginTop: 6 }}>
                  Issuing receipt...
                </div>
              )}
              {issuanceState === "FAILED" && (
                <div style={{ opacity: 0.85, marginTop: 6 }}>
                  Issuance failed. You can retry with{" "}
                  <b>Issue Receipt (Real)</b>. Fallback print will auto-trigger
                  if enabled.
                </div>
              )}
              {issuanceState === "TOKEN_READY" && snap?.receipt && (
                <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>Public URL</div>
                  <a
                    href={snap.receipt.public_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {snap.receipt.public_url}
                  </a>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>Token</div>
                  <div style={{ fontFamily: "monospace" }}>
                    {snap.receipt.token_id}
                  </div>
                </div>
              )}
            </div>

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

          {/* Timeline column */}
          <div
            style={{
              flex: 0.9,
              minWidth: 360,
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
              }}
            >
              <div style={{ fontWeight: 900 }}>Lifecycle Timeline</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                {timeline.length} events
              </div>
            </div>

            <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
              Durable source:{" "}
              <span style={{ fontFamily: "monospace" }}>
                public.pos_sim_events
              </span>
            </div>

            <div style={{ marginTop: 10, maxHeight: 760, overflow: "auto" }}>
              {timeline.length === 0 ? (
                <div style={{ fontSize: 13, opacity: 0.8 }}>
                  No events yet. If Timeline status shows FAILED, the insert is
                  failing — copy that error.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {timeline.map((e) => (
                    <div
                      key={e.id}
                      style={{
                        border: "1px solid #eee",
                        borderRadius: 10,
                        padding: 10,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 10,
                        }}
                      >
                        <div style={{ fontWeight: 900 }}>{e.event_type}</div>
                        <div style={{ fontSize: 12, opacity: 0.7 }}>
                          {fmtTime(e.created_at)}
                        </div>
                      </div>
                      <div
                        style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}
                      >
                        {shortJson(e.payload)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
