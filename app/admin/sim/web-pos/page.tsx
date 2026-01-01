// app/(admin)/sim/web-pos/page.tsx
"use client";

import { useMemo, useRef, useState } from "react";
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
} from "@/lib/posSimTypes";
import { channelName, makeEvent, snapshotPayload } from "@/lib/posSimRealtime";

const POS_SIM_ENABLED =
  (process.env.NEXT_PUBLIC_POS_SIM_ENABLED ?? "").toLowerCase() === "true" ||
  process.env.NEXT_PUBLIC_POS_SIM_ENABLED === "1";

const supabase = getSupabaseClient();

const DEMO_STORE_ID = "c3fde414-fdf9-4c50-aaea-004a10fe50ec";
const DEMO_TERMINAL_CODE = "TEST-001";

type SubscribeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

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

export default function WebPosSimBootstrapPage() {
  const [creating, setCreating] = useState(false);
  const [session, setSession] = useState<{
    session_id: string;
    session_code: string;
    customer_url: string;
    snapshot: PosSimSnapshot;
  } | null>(null);

  const channelRef = useRef<RealtimeChannel | null>(null);

  const customerFullUrl = useMemo(() => {
    if (!session) return "";
    if (typeof window === "undefined") return session.customer_url;
    return `${window.location.origin}${session.customer_url}`;
  }, [session]);

  async function startSession() {
    if (!POS_SIM_ENABLED) return;

    setCreating(true);
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

      const d = data as unknown;
      if (typeof d !== "object" || d === null)
        throw new Error("Invalid create-session response");
      const rd = d as Record<string, unknown>;

      const session_id =
        typeof rd.session_id === "string" ? rd.session_id : null;
      const session_code =
        typeof rd.session_code === "string" ? rd.session_code : null;
      const customer_url =
        typeof rd.customer_url === "string" ? rd.customer_url : null;
      const snapshot = rd.snapshot as PosSimSnapshot | undefined;

      if (!session_id || !session_code || !customer_url || !snapshot) {
        throw new Error("Invalid create-session response shape");
      }

      const created = { session_id, session_code, customer_url, snapshot };
      setSession(created);

      // Cleanup existing channel if any
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }

      const ch = supabase.channel(channelName(session_id), {
        config: { broadcast: { self: true } },
      });

      channelRef.current = ch;

      ch.on("broadcast", { event: "pos_sim" }, (msg: BroadcastMessage) => {
        const evUnknown = msg.payload;
        if (!isPosSimEvent(evUnknown)) return;

        // If customer joined, re-send snapshot (host is authoritative)
        if (evUnknown.type === "CUSTOMER_JOINED") {
          const snapEv = makeEvent(
            "SNAPSHOT_SYNC",
            session_id,
            snapshotPayload(created.snapshot)
          );
          void safeSend(ch, snapEv);
        }
      });

      await ch.subscribe(async (status: SubscribeStatus) => {
        if (status !== "SUBSCRIBED") return;

        const createdEv = makeEvent("SESSION_CREATED", session_id, {
          session_code,
          customer_url,
        });

        const snapEv = makeEvent(
          "SNAPSHOT_SYNC",
          session_id,
          snapshotPayload(created.snapshot)
        );

        await safeSend(ch, createdEv);
        await safeSend(ch, snapEv);
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("Start session failed:", message);
      alert(message);
    } finally {
      setCreating(false);
    }
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

  return (
    <div style={{ padding: 24, maxWidth: 900 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>
        Receiptless POS Simulator — Web POS (A1)
      </h1>
      <p style={{ marginTop: 8 }}>
        Milestone A1: session creation, customer pairing by code, snapshot sync
        over Supabase Realtime.
      </p>

      {!session ? (
        <div style={{ marginTop: 20 }}>
          <button
            onClick={startSession}
            disabled={creating}
            style={{
              padding: "12px 16px",
              borderRadius: 10,
              border: "1px solid #ccc",
              fontWeight: 700,
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
        <div style={{ marginTop: 20 }}>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            <div
              style={{
                padding: 16,
                border: "1px solid #ddd",
                borderRadius: 12,
                minWidth: 320,
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.7 }}>Session Code</div>
              <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: 2 }}>
                {session.session_code}
              </div>

              <div style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
                Customer Display
              </div>
              <a href={session.customer_url} target="_blank" rel="noreferrer">
                Open Customer Display
              </a>

              <div style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
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
            </div>

            <div
              style={{
                flex: 1,
                padding: 16,
                border: "1px solid #ddd",
                borderRadius: 12,
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.7 }}>Snapshot (A1)</div>
              <pre
                style={{
                  marginTop: 10,
                  fontSize: 12,
                  maxHeight: 320,
                  overflow: "auto",
                }}
              >
                {JSON.stringify(session.snapshot, null, 2)}
              </pre>
            </div>
          </div>

          <div style={{ marginTop: 16, fontSize: 13, opacity: 0.85 }}>
            Next: Milestone A2 will add cart building and CART_UPDATED events.
          </div>
        </div>
      )}
    </div>
  );
}
