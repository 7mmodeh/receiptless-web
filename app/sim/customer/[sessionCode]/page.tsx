// app/(admin)/sim/customer/[sessionCode]/page.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { getSupabaseClient } from "@/lib/supabaseClient";
import type {
  BroadcastMessage,
  JsonObject,
  PosSimEvent,
  PosSimSnapshot,
} from "@/lib/posSimTypes";
import { channelName, makeEvent } from "@/lib/posSimRealtime";

const POS_SIM_ENABLED =
  (process.env.NEXT_PUBLIC_POS_SIM_ENABLED ?? "").toLowerCase() === "true" ||
  process.env.NEXT_PUBLIC_POS_SIM_ENABLED === "1";

const supabase = getSupabaseClient();

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

function isSnapshotSync(
  ev: PosSimEvent
): ev is PosSimEvent & { payload: { snapshot: PosSimSnapshot } } {
  const p = ev.payload as Record<string, unknown>;
  return typeof p.snapshot === "object" && p.snapshot !== null;
}

type SubscribeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

export default function CustomerDisplayPage() {
  const params = useParams<{ sessionCode: string }>();
  const sessionCode = String(params.sessionCode ?? "").trim();

  const [loading, setLoading] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PosSimSnapshot | null>(null);
  const [status, setStatus] = useState<string>("Connecting...");

  const channelRef = useRef<RealtimeChannel | null>(null);

  const title = useMemo(() => {
    const tc = snapshot?.terminal?.terminal_code;
    return tc ? `Customer Display — ${tc}` : "Customer Display";
  }, [snapshot]);

  useEffect(() => {
    if (!POS_SIM_ENABLED) return;

    let mounted = true;

    async function run() {
      setLoading(true);
      setStatus("Loading session...");

      try {
        const { data, error } = await supabase
          .from("pos_sim_sessions")
          .select("session_id, snapshot_json")
          .eq("session_code", sessionCode)
          .maybeSingle();

        if (error) throw error;
        if (!data?.session_id) throw new Error("Session not found or expired");

        const sid = String(data.session_id);
        const snap = data.snapshot_json as PosSimSnapshot;

        if (!mounted) return;

        setSessionId(sid);
        setSnapshot(snap);
        setStatus("Subscribing...");

        if (channelRef.current) {
          supabase.removeChannel(channelRef.current);
          channelRef.current = null;
        }

        const ch = supabase.channel(channelName(sid), {
          config: { broadcast: { self: true } },
        });
        channelRef.current = ch;

        ch.on("broadcast", { event: "pos_sim" }, (msg: BroadcastMessage) => {
          const evUnknown = msg.payload;
          if (!isPosSimEvent(evUnknown)) return;

          if (evUnknown.type === "SNAPSHOT_SYNC" && isSnapshotSync(evUnknown)) {
            setSnapshot(evUnknown.payload.snapshot);
            setStatus("Live");
          }
        });

        await ch.subscribe(async (st: SubscribeStatus) => {
          if (st !== "SUBSCRIBED") return;

          setStatus("Live");

          const joinEv = makeEvent("CUSTOMER_JOINED", sid, {
            session_code: sessionCode,
          } satisfies JsonObject);

          await ch.send({
            type: "broadcast",
            event: "pos_sim",
            payload: joinEv,
          });
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Customer display load failed:", msg);
        if (!mounted) return;
        setStatus(msg);
      } finally {
        if (!mounted) return;
        setLoading(false);
      }
    }

    run();

    return () => {
      mounted = false;
      const ch = channelRef.current;
      channelRef.current = null;
      if (ch) supabase.removeChannel(ch);
    };
  }, [sessionCode]);

  if (!POS_SIM_ENABLED) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Customer Display</h1>
        <p style={{ marginTop: 8 }}>
          Not enabled. Set NEXT_PUBLIC_POS_SIM_ENABLED=true.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 24,
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "baseline",
        }}
      >
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Receiptless</div>
          <h1 style={{ fontSize: 28, fontWeight: 800, marginTop: 4 }}>
            {title}
          </h1>
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.8 }}>
            Session Code: <b style={{ letterSpacing: 2 }}>{sessionCode}</b>
          </div>
        </div>

        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Status</div>
          <div style={{ fontWeight: 700 }}>{status}</div>
        </div>
      </div>

      <div
        style={{
          padding: 18,
          border: "1px solid #ddd",
          borderRadius: 14,
          flex: 1,
        }}
      >
        {loading && (
          <div style={{ fontSize: 14, opacity: 0.85 }}>Loading...</div>
        )}

        {!loading && !snapshot && (
          <div style={{ fontSize: 14, opacity: 0.85 }}>
            No snapshot loaded. Session may be expired.
          </div>
        )}

        {snapshot && (
          <>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <div
                style={{
                  flex: 1,
                  minWidth: 260,
                  padding: 14,
                  border: "1px solid #eee",
                  borderRadius: 12,
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.7 }}>Stage</div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>
                  {snapshot.flow.stage}
                </div>

                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
                  Payment
                </div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>
                  {snapshot.flow.payment_state}
                </div>

                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
                  Receipt
                </div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>
                  {snapshot.flow.issuance_state}
                </div>
              </div>

              <div
                style={{
                  flex: 1,
                  minWidth: 260,
                  padding: 14,
                  border: "1px solid #eee",
                  borderRadius: 12,
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.7 }}>Total</div>
                <div style={{ fontSize: 34, fontWeight: 900 }}>
                  {snapshot.cart.currency}{" "}
                  {Number(snapshot.cart.total ?? 0).toFixed(2)}
                </div>
                <div style={{ marginTop: 8, fontSize: 13, opacity: 0.85 }}>
                  Waiting for cart updates in Milestone A2.
                </div>
              </div>
            </div>

            <div style={{ marginTop: 14, fontSize: 12, opacity: 0.7 }}>
              Snapshot (debug)
            </div>
            <pre
              style={{
                marginTop: 8,
                fontSize: 12,
                maxHeight: 320,
                overflow: "auto",
              }}
            >
              {JSON.stringify(snapshot, null, 2)}
            </pre>
          </>
        )}
      </div>

      <div style={{ fontSize: 12, opacity: 0.7 }}>
        Session ID:{" "}
        <span style={{ fontFamily: "monospace" }}>{sessionId ?? "—"}</span>
      </div>
    </div>
  );
}
