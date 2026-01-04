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

type ConsumeReceiptResponse = {
  ok: boolean;
  already_consumed?: boolean;
  token_id?: string;
  receipt_id?: string;
  consumed_at?: string;
  error?: string;
  details?: unknown;
};

const CATALOG: CatalogItem[] = [
  { sku: "SKU-001", name: "Mineral Water 500ml", price: 1.2, vat_rate: 0.23 },
  { sku: "SKU-002", name: "Chicken Wrap", price: 4.5, vat_rate: 0.13 },
  { sku: "SKU-003", name: "Chocolate Bar", price: 1.6, vat_rate: 0.23 },
  { sku: "SKU-004", name: "Coffee (Large)", price: 3.2, vat_rate: 0.23 },
];

/* ==========================
   Guards + helpers
========================== */

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

function safeJsonString(v: unknown, maxLen = 160): string {
  try {
    const s = JSON.stringify(stripUndefined(v));
    if (typeof s !== "string") return String(v);
    return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
  } catch {
    return String(v);
  }
}

function getString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function getNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function getRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  return v as Record<string, unknown>;
}

function normalizeDbEventRow(v: unknown): PosSimDbEvent | null {
  const r = getRecord(v);
  if (!r) return null;

  const id = getString(r.id);
  const session_id = getString(r.session_id);
  const event_type = getString(r.event_type);
  const created_at = getString(r.created_at);
  const payload = getRecord(r.payload);

  if (!id || !session_id || !event_type || !created_at || !payload) return null;

  return {
    id,
    session_id,
    event_type,
    created_at,
    payload: payload as unknown as JsonObject,
  };
}

function eventIsError(event_type: string, payload: JsonObject): boolean {
  if (
    event_type.includes("FAILED") ||
    event_type.includes("ERROR") ||
    event_type === "PAYMENT_RESULT"
  ) {
    const p = payload as unknown as Record<string, unknown>;
    const state = getString(p.state);
    if (event_type === "PAYMENT_RESULT") {
      return state !== null && state !== "APPROVED";
    }
    return true;
  }
  return false;
}

function eventIsCustomerAction(event_type: string): boolean {
  return (
    event_type === "CUSTOMER_JOINED" ||
    event_type === "CUSTOMER_SCANNED" ||
    event_type === "CHECKOUT_INITIATED"
  );
}

function eventIsReceiptToken(event_type: string): boolean {
  return (
    event_type.includes("RECEIPT") ||
    event_type.includes("TOKEN") ||
    event_type === "ISSUANCE_FAIL"
  );
}

function eventIsFallback(event_type: string): boolean {
  return event_type === "FALLBACK_PRINTED";
}

function eventLabel(event_type: string): { icon: string; label: string } {
  // No new deps; compact “icons” via ASCII-ish glyphs.
  const map: Record<string, { icon: string; label: string }> = {
    SESSION_CREATED: { icon: "●", label: "Session created" },
    NEW_SALE_STARTED: { icon: "◇", label: "New sale" },
    RESET_REQUESTED: { icon: "↻", label: "Reset requested" },

    CART_UPDATED: { icon: "≡", label: "Cart updated" },
    CART_CLEARED: { icon: "⌫", label: "Cart cleared" },
    STAGE_CHANGED: { icon: "→", label: "Stage changed" },
    CHECKOUT_INITIATED: { icon: "⇢", label: "Checkout initiated" },

    PAYMENT_PROCESSING: { icon: "…", label: "Payment processing" },
    PAYMENT_RESULT: { icon: "✓", label: "Payment result" },

    RECEIPT_ISSUANCE_STARTED: { icon: "⇣", label: "Receipt issuance started" },
    RECEIPT_TOKEN_READY: { icon: "▣", label: "Receipt token ready" },
    RECEIPT_ISSUANCE_FAILED: { icon: "!", label: "Receipt issuance failed" },

    RECEIPT_CONSUMED_RETURN: { icon: "↩", label: "Receipt consumed (return)" },
    RECEIPT_CONSUME_FAILED: { icon: "!", label: "Receipt consume failed" },

    CUSTOMER_JOINED: { icon: "👤", label: "Customer joined" }, // OK for clarity
    CUSTOMER_SCANNED: { icon: "⌁", label: "Customer scanned" },

    TOGGLE_UPDATED: { icon: "⚙", label: "Toggle updated" },

    FALLBACK_PRINTED: { icon: "⎙", label: "Fallback printed" },
  };

  return map[event_type] ?? { icon: "•", label: event_type };
}

function concisePayload(event_type: string, payload: JsonObject): string {
  const p = payload as unknown as Record<string, unknown>;
  const sale_id = getString(p.sale_id);

  if (event_type === "CART_UPDATED") {
    const items_count = getNumber(p.items_count);
    const total = getNumber(p.total);
    const parts = [
      sale_id ? `sale=${sale_id.slice(0, 8)}` : null,
      items_count !== null ? `items=${items_count}` : null,
      total !== null ? `total=${total.toFixed(2)}` : null,
    ].filter(Boolean);
    return parts.join(" · ") || safeJsonString(payload);
  }

  if (event_type === "PAYMENT_RESULT") {
    const state = getString(p.state);
    const parts = [
      sale_id ? `sale=${sale_id.slice(0, 8)}` : null,
      state ? `state=${state}` : null,
    ].filter(Boolean);
    return parts.join(" · ") || safeJsonString(payload);
  }

  if (event_type === "PAYMENT_PROCESSING") {
    const total = getNumber(p.total);
    const currency = getString(p.currency);
    const parts = [
      sale_id ? `sale=${sale_id.slice(0, 8)}` : null,
      total !== null ? `total=${total.toFixed(2)}` : null,
      currency ? currency : null,
    ].filter(Boolean);
    return parts.join(" · ") || safeJsonString(payload);
  }

  if (event_type === "RECEIPT_TOKEN_READY") {
    const token_id = getString(p.token_id);
    const public_url = getString(p.public_url);
    const parts = [
      sale_id ? `sale=${sale_id.slice(0, 8)}` : null,
      token_id ? `token=${token_id.slice(0, 8)}` : null,
      public_url ? "url=ready" : null,
    ].filter(Boolean);
    return parts.join(" · ") || safeJsonString(payload);
  }

  if (event_type === "RECEIPT_ISSUANCE_FAILED") {
    const message = getString(p.message);
    const parts = [
      sale_id ? `sale=${sale_id.slice(0, 8)}` : null,
      message ? `msg=${message}` : null,
    ].filter(Boolean);
    return parts.join(" · ") || safeJsonString(payload);
  }

  if (event_type === "CUSTOMER_SCANNED") {
    const outcome = getString(p.outcome);
    const token_id = getString(p.token_id);
    const message = getString(p.message);
    const parts = [
      sale_id ? `sale=${sale_id.slice(0, 8)}` : null,
      outcome ? `outcome=${outcome}` : null,
      token_id ? `token=${token_id.slice(0, 8)}` : null,
      message ? message : null,
    ].filter(Boolean);
    return parts.join(" · ") || safeJsonString(payload);
  }

  if (event_type === "FALLBACK_PRINTED") {
    const reason = getString(p.reason);
    const parts = [
      sale_id ? `sale=${sale_id.slice(0, 8)}` : null,
      reason ? `reason=${reason}` : null,
    ].filter(Boolean);
    return parts.join(" · ") || safeJsonString(payload);
  }

  if (event_type === "TOGGLE_UPDATED") {
    const toggle = getString(p.toggle);
    const value = getString(p.value);
    const parts = [
      sale_id ? `sale=${sale_id.slice(0, 8)}` : null,
      toggle ? toggle : null,
      value ? `=${value}` : null,
    ].filter(Boolean);
    return parts.join(" ") || safeJsonString(payload);
  }

  if (event_type === "NEW_SALE_STARTED") {
    const sid = getString(p.sale_id);
    return sid ? `sale=${sid.slice(0, 8)}` : safeJsonString(payload);
  }

  if (event_type === "RECEIPT_CONSUMED_RETURN") {
    const token_id = getString(p.token_id);
    const already =
      typeof p.already_consumed === "boolean" ? p.already_consumed : null;
    const consumed_at = getString(p.consumed_at);
    const parts = [
      sale_id ? `sale=${sale_id.slice(0, 8)}` : null,
      token_id ? `token=${token_id.slice(0, 8)}` : null,
      already !== null ? `already=${already}` : null,
      consumed_at ? `at=${fmtTime(consumed_at)}` : null,
    ].filter(Boolean);
    return parts.join(" · ") || safeJsonString(payload);
  }

  if (event_type === "RECEIPT_CONSUME_FAILED") {
    const message = getString(p.message);
    const parts = [
      sale_id ? `sale=${sale_id.slice(0, 8)}` : null,
      message ? `msg=${message}` : null,
    ].filter(Boolean);
    return parts.join(" · ") || safeJsonString(payload);
  }

  return safeJsonString(payload);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/* ==========================
   Component
========================== */

export default function WebPosSimPageA5() {
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

  // Filters + expanders
  const [filterSaleOnly, setFilterSaleOnly] = useState(false);
  const [filterErrorsOnly, setFilterErrorsOnly] = useState(false);
  const [filterCustomerActions, setFilterCustomerActions] = useState(false);
  const [filterReceiptToken, setFilterReceiptToken] = useState(false);
  const [filterFallbackOnly, setFilterFallbackOnly] = useState(false);
  const [expandRaw, setExpandRaw] = useState<Record<string, boolean>>({});
  const [collapseSales, setCollapseSales] = useState<Record<string, boolean>>(
    {}
  );

  // Canonical realtime + snapshot
  const channelRef = useRef<RealtimeChannel | null>(null);
  const snapshotRef = useRef<PosSimSnapshot | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const payTimerRef = useRef<number | null>(null);
  const issuingRef = useRef(false);

  // Return consumption UI state
  const [consumingReturn, setConsumingReturn] = useState(false);

  // Track whether we seeded the sale id at session start
  const seededSaleAtStartRef = useRef(false);

  const customerFullUrl = useMemo(() => {
    if (!session) return "";
    if (typeof window === "undefined") return session.customer_url;
    return `${window.location.origin}${session.customer_url}`;
  }, [session]);

  function getSnap(): PosSimSnapshot | null {
    return snapshotRef.current ?? session?.snapshot ?? null;
  }

  function withSale(snap: PosSimSnapshot, payload: JsonObject): JsonObject {
    return {
      sale_id: snap.active_sale_id ?? null,
      ...payload,
    } as unknown as JsonObject;
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

  /* ==========================
     Durable timeline (Option B)
  ========================== */

  async function logDbEvent(event_type: string, payload: JsonObject) {
    const sid = sessionIdRef.current;
    if (!sid) return;

    setTimelineWriteStatus("writing…");

    const safePayload = stripUndefined(payload) as JsonObject;

    const { data, error } = await supabase.rpc("pos_sim_log_event", {
      p_session_id: sid,
      p_event_type: event_type,
      p_payload: safePayload as unknown as Record<string, unknown>,
    });

    if (error) {
      setTimelineWriteStatus(`FAILED: ${error.message}`);
      // // eslint-disable-next-line no-console
      console.error("pos_sim_log_event RPC failed:", error);
      return;
    }

    const row = normalizeDbEventRow(data);
    if (!row) {
      setTimelineWriteStatus("FAILED: invalid RPC return shape");
      // // eslint-disable-next-line no-console
      console.error("pos_sim_log_event returned unexpected data:", data);
      return;
    }

    setTimelineWriteStatus("ok");
    setTimeline((prev) => {
      if (prev.some((e) => e.id === row.id)) return prev;
      return [...prev, row];
    });
  }

  async function loadTimelineAndSubscribe(sessionId: string) {
    const { data, error } = await supabase.rpc("pos_sim_get_events", {
      p_session_id: sessionId,
      p_limit: 800,
    });

    if (error) {
      setTimelineWriteStatus(`read FAILED: ${error.message}`);
    } else if (Array.isArray(data)) {
      const rows = data
        .map(normalizeDbEventRow)
        .filter(Boolean) as PosSimDbEvent[];
      setTimeline(rows);
      setTimelineWriteStatus("read ok");
    }

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
        const row = normalizeDbEventRow(payload.new);
        if (!row) return;
        setTimeline((prev) => {
          if (prev.some((e) => e.id === row.id)) return prev;
          return [...prev, row];
        });
      }
    );

    tch.subscribe((st) => {
      if (st === "CHANNEL_ERROR") {
        setTimelineWriteStatus((s) => `${s} | realtime CHANNEL_ERROR`);
      }
    });
  }

  /* ==========================
     Canonical snapshot
  ========================== */

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
      // // eslint-disable-next-line no-console
      console.error("Snapshot DB update failed:", upErr);
      setHostStatus(`DB update failed: ${upErr.message}`);
    }

    // Keep SNAPSHOT_SYNC as the only realtime UI driver.
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
      const enriched = withSale(nextSnap, event_payload ?? ({} as JsonObject));
      await logDbEvent(event_type, enriched);
    }
  }

  /* ==========================
     Paper receipt fallback
  ========================== */

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
        "Print not allowed (toggle disabled / not approved / already printed)"
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

  /* ==========================
     Session start
  ========================== */

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

      // Seed sale id immediately so lifecycle grouping works from first event.
      seededSaleAtStartRef.current = false;
      let seededSnapshot = snapshot;

      if (!seededSnapshot.active_sale_id) {
        seededSaleAtStartRef.current = true;
        seededSnapshot = {
          ...seededSnapshot,
          active_sale_id: newSaleId(),
          flow: {
            stage: "CART",
            payment_state: "IDLE",
            issuance_state: "IDLE",
          },
          receipt: null,
          scan: { state: "NONE" },
          fallback: { printed: false, print_reason: null },
          cart: {
            currency: seededSnapshot.cart.currency ?? "EUR",
            items: seededSnapshot.cart.items ?? [],
            subtotal: Number(seededSnapshot.cart.subtotal ?? 0),
            vat_total: Number(seededSnapshot.cart.vat_total ?? 0),
            total: Number(seededSnapshot.cart.total ?? 0),
          },
        };
      }

      const created = {
        session_id,
        session_code,
        customer_url,
        snapshot: seededSnapshot,
      };

      setSession(created);
      snapshotRef.current = seededSnapshot;
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
            const outcome = p.outcome === "success" ? "SUCCESS" : "FAIL";
            const message =
              typeof p.message === "string"
                ? p.message
                : outcome === "SUCCESS"
                ? "Receipt linked to wallet (simulated)."
                : "Scan failed (simulated).";

            const nextSnap: PosSimSnapshot = {
              ...snap,
              scan: {
                state: outcome === "SUCCESS" ? "SUCCESS" : "FAIL",
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
              token_id: snap.receipt?.token_id ?? null,
            } as unknown as JsonObject);

            if (outcome === "FAIL" && canAutoFallbackPrint(nextSnap)) {
              await fallbackPrint("SCAN_FAIL");
            }
          }
        }
      );

      ch.subscribe(async (st: SubscribeStatus) => {
        if (st === "SUBSCRIBED") {
          setHostStatus("Live");

          // Persist seeded canonical snapshot and emit lifecycle events consistently.
          const snapNow = snapshotRef.current ?? seededSnapshot;

          await logDbEvent("SESSION_CREATED", {
            session_code,
            customer_url,
            mode: "web_pos",
          } as unknown as JsonObject);

          // Start-of-session: ensure canonical snapshot in DB matches our seeded snapshot.
          // Also keep the initial realtime SNAPSHOT_SYNC in place.
          const createdEv = makeEvent("SESSION_CREATED", session_id, {
            session_code,
            customer_url,
          } as unknown as JsonObject);

          const snapEv = makeEvent(
            "SNAPSHOT_SYNC",
            session_id,
            snapshotPayload(snapNow)
          );

          await safeSend(ch, createdEv);
          await safeSend(ch, snapEv);

          // If we seeded an active sale id, emit NEW_SALE_STARTED once and persist snapshot.
          if (seededSaleAtStartRef.current) {
            await persistAndBroadcast(snapNow, "NEW_SALE_STARTED", {
              sale_id: snapNow.active_sale_id ?? null,
            } as unknown as JsonObject);
          } else {
            // Still persist snapshot once to ensure DB is aligned
            await persistSnapshot(snapNow);
          }

          return;
        }

        if (st === "TIMED_OUT") setHostStatus("Realtime timed out");
        if (st === "CHANNEL_ERROR") setHostStatus("Realtime channel error");
        if (st === "CLOSED") setHostStatus("Realtime closed");
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      // // eslint-disable-next-line no-console
      console.error("Start session failed:", e);
      setHostStatus(`Error: ${message}`);
      alert(message);
    } finally {
      setCreating(false);
    }
  }

  /* ==========================
     Cart ops
  ========================== */

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

    void persistAndBroadcast(nextSnap, "TOGGLE_UPDATED", {
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
    void persistAndBroadcast(nextSnap, "STAGE_CHANGED", {
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

  async function resetDemo() {
    const snap = getSnap();
    if (!snap) return;

    issuingRef.current = false;

    if (payTimerRef.current) {
      window.clearTimeout(payTimerRef.current);
      payTimerRef.current = null;
    }

    // Reset means: clear flow + receipt + scan + fallback + cart, and start a fresh sale id.
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

    setHostStatus("Reset complete");
    // Emit consistency: RESET_REQUESTED + NEW_SALE_STARTED
    await persistAndBroadcast(nextSnap, "RESET_REQUESTED", {} as JsonObject);
    await persistAndBroadcast(nextSnap, "NEW_SALE_STARTED", {
      sale_id: nextSnap.active_sale_id ?? null,
    } as unknown as JsonObject);
  }

  /* ==========================
     Payment
  ========================== */

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
    }, delay);
  }

  /* ==========================
     Receipt issuance
  ========================== */

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

      // RL-011/RL-020 idempotency anchor:
      sale_id: snap.active_sale_id, // REQUIRED

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

      if (canAutoFallbackPrint(failedSnap)) {
        await fallbackPrint("ISSUANCE_FAIL");
      }
    } finally {
      issuingRef.current = false;
    }
  }

  // Return consumption (RL-022)
  async function consumeForReturn() {
    const snap = getSnap();
    if (!snap) return;

    const tokenId = snap.receipt?.token_id ?? null;
    if (!tokenId) {
      setHostStatus("No token to consume (issue a receipt first)");
      return;
    }

    if (consumingReturn) return;
    setConsumingReturn(true);

    try {
      setHostStatus("Consuming receipt (return) ...");

      const res = await fetch("/api/pos-sim/consume-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          retailer_id: snap.terminal.retailer_id,
          store_id: snap.terminal.store_id,
          terminal_code: snap.terminal.terminal_code,
          token_id: tokenId,
          reason: "return_refund",
        }),
      });

      const out = (await res
        .json()
        .catch(() => null)) as ConsumeReceiptResponse | null;

      if (!res.ok) {
        const details = out?.details ?? out ?? { status: res.status };
        throw new Error(
          typeof details === "string" ? details : JSON.stringify(details)
        );
      }

      if (!out || typeof out.ok !== "boolean") {
        throw new Error("Invalid receipt-consume response");
      }

      const already = Boolean(out?.already_consumed);
      const consumed_at =
        typeof out?.consumed_at === "string" ? out.consumed_at : null;

      setHostStatus(
        already
          ? "Return: already consumed (idempotent)"
          : "Return: consumed OK"
      );

      await logDbEvent("RECEIPT_CONSUMED_RETURN", {
        sale_id: snap.active_sale_id ?? null,
        token_id: tokenId,
        already_consumed: already,
        consumed_at,
      } as unknown as JsonObject);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setHostStatus(`Return consume failed: ${msg}`);
      await logDbEvent("RECEIPT_CONSUME_FAILED", {
        sale_id: snap?.active_sale_id ?? null,
        message: msg,
      } as unknown as JsonObject);
    } finally {
      setConsumingReturn(false);
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

  /* ==========================
     Guided demo macros (A5)
  ========================== */

  async function macroHappyPath() {
    const snap = getSnap();
    if (!snap) return;

    setHostStatus("Macro: Happy path");
    // Reset first (clean semantics)
    await resetDemo();

    // Add 2 items quickly
    addItem(CATALOG[0]);
    await sleep(200);
    addItem(CATALOG[1]);
    await sleep(250);

    // Ensure best toggles
    const s1 = getSnap();
    if (!s1) return;

    await persistAndBroadcast(
      {
        ...s1,
        toggles: {
          ...s1.toggles,
          network_mode: "normal",
          payment_outcome: "success",
          issuance_mode: "normal",
          customer_scan_sim: "auto_success",
        },
      },
      "TOGGLE_UPDATED",
      { toggle: "macro", value: "happy_path" } as unknown as JsonObject
    );

    await sleep(200);
    goToCheckout();
    await sleep(250);
    pay();

    // Wait for payment to resolve + issuance auto
    await sleep(2200);

    setHostStatus("Macro: Happy path completed");
  }

  async function macroIssuanceFailFallback() {
    const snap = getSnap();
    if (!snap) return;

    setHostStatus("Macro: Issuance fail → fallback print");
    await resetDemo();

    addItem(CATALOG[2]);
    await sleep(200);
    goToCheckout();
    await sleep(250);

    // Ensure payment succeeds, print fallback enabled, and issuance will be forced by failure path:
    // We simulate issuance failure by setting issuance_mode to fail and then calling issueReceipt;
    // Your backend must respect issuance_mode if you wire it, otherwise issuance fails naturally via API error.
    const s1 = getSnap();
    if (!s1) return;

    const s2: PosSimSnapshot = {
      ...s1,
      toggles: {
        ...s1.toggles,
        network_mode: "normal",
        payment_outcome: "success",
        print_fallback: "enabled",
        issuance_mode: "fail",
      },
    };
    await persistAndBroadcast(s2, "TOGGLE_UPDATED", {
      toggle: "macro",
      value: "issuance_fail_fallback",
    } as unknown as JsonObject);

    await sleep(200);
    pay();
    await sleep(2200);

    // Force a manual issuance attempt (if auto issuance already ran, this will be disabled by state)
    await sleep(250);
    await issueReceipt();

    setHostStatus(
      "Macro: Issuance fail path done (fallback prints if eligible)"
    );
  }

  async function macroScanFailFallback() {
    const snap = getSnap();
    if (!snap) return;

    setHostStatus("Macro: Scan fail → fallback print");
    await resetDemo();

    addItem(CATALOG[3]);
    await sleep(200);
    goToCheckout();
    await sleep(250);

    const s1 = getSnap();
    if (!s1) return;

    const s2: PosSimSnapshot = {
      ...s1,
      toggles: {
        ...s1.toggles,
        network_mode: "normal",
        payment_outcome: "success",
        print_fallback: "enabled",
        customer_scan_sim: "auto_fail",
      },
    };
    await persistAndBroadcast(s2, "TOGGLE_UPDATED", {
      toggle: "macro",
      value: "scan_fail_fallback",
    } as unknown as JsonObject);

    await sleep(200);
    pay();
    // Wait for payment, issuance, then customer auto-scan fail is emitted by customer UI;
    // If customer page is open, it will broadcast; otherwise you can manually open the customer page.
    await sleep(2400);

    setHostStatus(
      "Macro: Waiting for customer scan fail (open customer display if not open)"
    );
  }

  async function macroNetworkDownAtPay() {
    const snap = getSnap();
    if (!snap) return;

    setHostStatus("Macro: Network down at pay");
    await resetDemo();

    addItem(CATALOG[0]);
    await sleep(200);
    goToCheckout();
    await sleep(250);

    const s1 = getSnap();
    if (!s1) return;

    const s2: PosSimSnapshot = {
      ...s1,
      toggles: {
        ...s1.toggles,
        network_mode: "down",
        payment_outcome: "success",
      },
    };
    await persistAndBroadcast(s2, "TOGGLE_UPDATED", {
      toggle: "macro",
      value: "network_down_pay",
    } as unknown as JsonObject);

    await sleep(200);
    pay();

    setHostStatus("Macro: Network down at pay completed");
  }

  /* ==========================
     Timeline grouping + filters
  ========================== */

  const currentSaleId = getSnap()?.active_sale_id ?? null;

  const filteredTimeline = useMemo(() => {
    const curSale = currentSaleId;

    return timeline.filter((e) => {
      const payload = e.payload as unknown as Record<string, unknown>;
      const sale_id = getString(payload.sale_id);

      if (filterSaleOnly && curSale) {
        if (sale_id !== curSale) return false;
      }

      if (filterErrorsOnly) {
        if (!eventIsError(e.event_type, e.payload)) return false;
      }

      if (filterCustomerActions) {
        if (!eventIsCustomerAction(e.event_type)) return false;
      }

      if (filterReceiptToken) {
        if (!eventIsReceiptToken(e.event_type)) return false;
      }

      if (filterFallbackOnly) {
        if (!eventIsFallback(e.event_type)) return false;
      }

      return true;
    });
  }, [
    timeline,
    currentSaleId,
    filterSaleOnly,
    filterErrorsOnly,
    filterCustomerActions,
    filterReceiptToken,
    filterFallbackOnly,
  ]);

  const grouped = useMemo(() => {
    // Group by payload.sale_id; events without sale_id go into "session"
    const by: Record<string, PosSimDbEvent[]> = {};
    for (const e of filteredTimeline) {
      const payload = e.payload as unknown as Record<string, unknown>;
      const sale_id = getString(payload.sale_id) ?? "session";
      if (!by[sale_id]) by[sale_id] = [];
      by[sale_id].push(e);
    }

    // Sort groups: current sale first, then most recent activity
    const entries = Object.entries(by).map(([k, v]) => {
      const lastTs = v.reduce((m, x) => {
        const t = Date.parse(x.created_at);
        return Number.isFinite(t) ? Math.max(m, t) : m;
      }, 0);
      return { key: k, events: v, lastTs };
    });

    entries.sort((a, b) => {
      if (a.key === currentSaleId) return -1;
      if (b.key === currentSaleId) return 1;
      return b.lastTs - a.lastTs;
    });

    return entries;
  }, [filteredTimeline, currentSaleId]);

  /* ==========================
     Render
  ========================== */

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

  const showConsumeReturnButton =
    !!snap &&
    !!snap.receipt?.token_id &&
    snap.flow.payment_state === "APPROVED";

  return (
    <div style={{ padding: 24, maxWidth: 1320 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800 }}>
        Receiptless POS Simulator — Web POS (A5)
      </h1>
      <p style={{ marginTop: 8 }}>
        Canonical: <b>pos_sim_sessions.snapshot_json</b>. Durable audit trail:{" "}
        <b>pos_sim_events</b> (SECURITY DEFINER RPC). <b>SNAPSHOT_SYNC</b>{" "}
        drives UI sync.
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

                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
                  Active Sale ID
                </div>
                <div style={{ fontFamily: "monospace", fontSize: 12 }}>
                  {snap?.active_sale_id ?? "—"}
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
              Guided Demo (One-click macros)
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                onClick={() => void macroHappyPath()}
                style={{
                  border: "1px solid #111",
                  background: "#111",
                  color: "white",
                  borderRadius: 10,
                  padding: "8px 10px",
                  fontWeight: 900,
                }}
              >
                Happy path
              </button>
              <button
                onClick={() => void macroIssuanceFailFallback()}
                style={{
                  border: "1px solid #ccc",
                  background: "white",
                  borderRadius: 10,
                  padding: "8px 10px",
                  fontWeight: 900,
                }}
              >
                Issuance fail → fallback
              </button>
              <button
                onClick={() => void macroScanFailFallback()}
                style={{
                  border: "1px solid #ccc",
                  background: "white",
                  borderRadius: 10,
                  padding: "8px 10px",
                  fontWeight: 900,
                }}
              >
                Scan fail → fallback
              </button>
              <button
                onClick={() => void macroNetworkDownAtPay()}
                style={{
                  border: "1px solid #ccc",
                  background: "white",
                  borderRadius: 10,
                  padding: "8px 10px",
                  fontWeight: 900,
                }}
              >
                Network down at pay
              </button>
            </div>

            <hr style={{ margin: "14px 0" }} />

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
                onClick={() => void resetDemo()}
                style={{
                  border: "1px solid #ccc",
                  borderRadius: 10,
                  padding: "8px 10px",
                  background: "white",
                  fontWeight: 800,
                }}
              >
                Reset
              </button>
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

          {/* Right column (POS UI) */}
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
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={clearCart}
                  disabled={stage === "PROCESSING"}
                  style={{
                    border: "1px solid #ccc",
                    borderRadius: 10,
                    padding: "8px 10px",
                    background: "white",
                    opacity: stage === "PROCESSING" ? 0.6 : 1,
                    fontWeight: 800,
                  }}
                >
                  Clear Cart
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

              {/* RL-022: Consume (Return) */}
              <button
                onClick={() => void consumeForReturn()}
                disabled={!showConsumeReturnButton || consumingReturn}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid #b00",
                  background: "white",
                  fontWeight: 900,
                  opacity:
                    !showConsumeReturnButton || consumingReturn ? 0.6 : 1,
                }}
                title="Simulate return desk consumption of this receipt token"
              >
                {consumingReturn ? "Consuming..." : "Consume (Return)"}
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
                  Issuance failed. Retry with <b>Issue Receipt (Real)</b>.
                  Fallback print auto-triggers if enabled.
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
          </div>

          {/* Timeline column (A5) */}
          <div
            style={{
              flex: 0.95,
              minWidth: 380,
              border: "1px solid #ddd",
              borderRadius: 12,
              padding: 14,
              position: "relative",
            }}
          >
            {/* Sticky Latest State header */}
            <div
              style={{
                position: "sticky",
                top: 0,
                background: "white",
                zIndex: 2,
                paddingBottom: 10,
                borderBottom: "1px solid #eee",
                marginBottom: 10,
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
                  {filteredTimeline.length} events
                </div>
              </div>

              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                Latest state (canonical snapshot)
              </div>
              <div
                style={{ marginTop: 6, display: "grid", gap: 6, fontSize: 12 }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <span style={{ opacity: 0.75 }}>Sale</span>
                  <span style={{ fontFamily: "monospace" }}>
                    {snap?.active_sale_id
                      ? snap.active_sale_id.slice(0, 12)
                      : "—"}
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <span style={{ opacity: 0.75 }}>Stage</span>
                  <span style={{ fontWeight: 800 }}>{stage}</span>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <span style={{ opacity: 0.75 }}>Payment</span>
                  <span style={{ fontWeight: 800 }}>{payState}</span>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <span style={{ opacity: 0.75 }}>Issuance</span>
                  <span style={{ fontWeight: 800 }}>{issuanceState}</span>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <span style={{ opacity: 0.75 }}>Scan</span>
                  <span style={{ fontWeight: 800 }}>{scanState}</span>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <span style={{ opacity: 0.75 }}>Total</span>
                  <span style={{ fontWeight: 900 }}>
                    {snap?.cart.currency ?? "EUR"}{" "}
                    {Number(snap?.cart.total ?? 0).toFixed(2)}
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <span style={{ opacity: 0.75 }}>Token</span>
                  <span style={{ fontFamily: "monospace" }}>
                    {snap?.receipt?.token_id
                      ? snap.receipt.token_id.slice(0, 12)
                      : "—"}
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <span style={{ opacity: 0.75 }}>Fallback</span>
                  <span style={{ fontWeight: 800 }}>
                    {snap?.fallback?.printed
                      ? `Printed (${snap.fallback.print_reason ?? "—"})`
                      : "Not printed"}
                  </span>
                </div>
              </div>

              {/* Filters */}
              <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
                <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>
                  Filters
                </div>

                <label
                  style={{ display: "flex", gap: 8, alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    checked={filterSaleOnly}
                    onChange={(e) => setFilterSaleOnly(e.target.checked)}
                  />
                  <span style={{ fontSize: 12 }}>Sale only (current sale)</span>
                </label>

                <label
                  style={{ display: "flex", gap: 8, alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    checked={filterErrorsOnly}
                    onChange={(e) => setFilterErrorsOnly(e.target.checked)}
                  />
                  <span style={{ fontSize: 12 }}>Errors only</span>
                </label>

                <label
                  style={{ display: "flex", gap: 8, alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    checked={filterCustomerActions}
                    onChange={(e) => setFilterCustomerActions(e.target.checked)}
                  />
                  <span style={{ fontSize: 12 }}>Customer actions</span>
                </label>

                <label
                  style={{ display: "flex", gap: 8, alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    checked={filterReceiptToken}
                    onChange={(e) => setFilterReceiptToken(e.target.checked)}
                  />
                  <span style={{ fontSize: 12 }}>Receipt / Token</span>
                </label>

                <label
                  style={{ display: "flex", gap: 8, alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    checked={filterFallbackOnly}
                    onChange={(e) => setFilterFallbackOnly(e.target.checked)}
                  />
                  <span style={{ fontSize: 12 }}>Fallback prints</span>
                </label>
              </div>
            </div>

            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Durable source:{" "}
              <span style={{ fontFamily: "monospace" }}>
                public.pos_sim_events
              </span>
            </div>

            <div style={{ marginTop: 10, maxHeight: 760, overflow: "auto" }}>
              {grouped.length === 0 ? (
                <div style={{ fontSize: 13, opacity: 0.8 }}>
                  No events yet. If Timeline status shows FAILED, the RPC is
                  failing.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {grouped.map((g) => {
                    const isSession = g.key === "session";
                    const collapsed = !!collapseSales[g.key];
                    const title = isSession
                      ? "Session-level"
                      : g.key === currentSaleId
                      ? `Current Sale (${g.key.slice(0, 8)})`
                      : `Sale (${g.key.slice(0, 8)})`;

                    return (
                      <div
                        key={g.key}
                        style={{
                          border: "1px solid #eee",
                          borderRadius: 12,
                          padding: 10,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 10,
                            alignItems: "center",
                          }}
                        >
                          <div style={{ fontWeight: 900 }}>{title}</div>
                          <button
                            onClick={() =>
                              setCollapseSales((p) => ({
                                ...p,
                                [g.key]: !p[g.key],
                              }))
                            }
                            style={{
                              border: "1px solid #ccc",
                              background: "white",
                              borderRadius: 10,
                              padding: "6px 10px",
                              fontWeight: 800,
                            }}
                          >
                            {collapsed ? "Expand" : "Collapse"}
                          </button>
                        </div>

                        {!collapsed && (
                          <div
                            style={{ marginTop: 10, display: "grid", gap: 8 }}
                          >
                            {g.events.map((e) => {
                              const lbl = eventLabel(e.event_type);
                              const isErr = eventIsError(
                                e.event_type,
                                e.payload
                              );
                              const expanded = !!expandRaw[e.id];

                              return (
                                <div
                                  key={e.id}
                                  style={{
                                    border: "1px solid #f0f0f0",
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
                                    <div
                                      style={{
                                        display: "flex",
                                        gap: 10,
                                        alignItems: "center",
                                      }}
                                    >
                                      <div
                                        style={{
                                          width: 22,
                                          height: 22,
                                          borderRadius: 8,
                                          border: "1px solid #ddd",
                                          display: "flex",
                                          alignItems: "center",
                                          justifyContent: "center",
                                          fontWeight: 900,
                                          opacity: isErr ? 1 : 0.85,
                                        }}
                                        title={lbl.label}
                                      >
                                        {lbl.icon}
                                      </div>
                                      <div>
                                        <div style={{ fontWeight: 900 }}>
                                          {lbl.label}
                                          {isErr ? (
                                            <span
                                              style={{
                                                marginLeft: 8,
                                                fontSize: 12,
                                                opacity: 0.9,
                                              }}
                                            >
                                              (error)
                                            </span>
                                          ) : null}
                                        </div>
                                        <div
                                          style={{
                                            fontSize: 12,
                                            opacity: 0.75,
                                          }}
                                        >
                                          {e.event_type}
                                        </div>
                                      </div>
                                    </div>

                                    <div style={{ textAlign: "right" }}>
                                      <div
                                        style={{ fontSize: 12, opacity: 0.7 }}
                                      >
                                        {fmtTime(e.created_at)}
                                      </div>
                                      <button
                                        onClick={() =>
                                          setExpandRaw((p) => ({
                                            ...p,
                                            [e.id]: !p[e.id],
                                          }))
                                        }
                                        style={{
                                          marginTop: 6,
                                          border: "1px solid #ccc",
                                          background: "white",
                                          borderRadius: 10,
                                          padding: "6px 10px",
                                          fontWeight: 800,
                                          fontSize: 12,
                                        }}
                                      >
                                        {expanded ? "Hide JSON" : "Show JSON"}
                                      </button>
                                    </div>
                                  </div>

                                  <div
                                    style={{
                                      marginTop: 8,
                                      fontSize: 12,
                                      opacity: 0.9,
                                    }}
                                  >
                                    {concisePayload(e.event_type, e.payload)}
                                  </div>

                                  {expanded && (
                                    <pre
                                      style={{
                                        marginTop: 10,
                                        fontSize: 12,
                                        maxHeight: 240,
                                        overflow: "auto",
                                        background: "#fafafa",
                                        border: "1px solid #eee",
                                        borderRadius: 10,
                                        padding: 10,
                                      }}
                                    >
                                      {safeJsonString(e.payload, 2000)}
                                    </pre>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
              Session ID:{" "}
              <span style={{ fontFamily: "monospace" }}>
                {session.session_id}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
