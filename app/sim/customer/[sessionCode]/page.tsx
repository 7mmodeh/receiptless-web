// app/sim/customer/[sessionCode]/page.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import Image from "next/image";
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

type SubscribeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

function toStatus(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.message;
  if (typeof v === "object" && v !== null) {
    const r = v as Record<string, unknown>;
    const message = typeof r.message === "string" ? r.message : null;
    const details = typeof r.details === "string" ? r.details : null;
    const hint = typeof r.hint === "string" ? r.hint : null;
    if (message || details || hint)
      return [message, details, hint].filter(Boolean).join(" | ");
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

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

function makeQrUrl(data: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(
    data
  )}`;
}

export default function CustomerDisplayPage() {
  const supabase = useMemo(() => getSupabaseClient(), []);

  const params = useParams<{ sessionCode: string }>();
  const sessionCode = String(params.sessionCode ?? "").trim();

  const [loading, setLoading] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PosSimSnapshot | null>(null);
  const [status, setStatus] = useState<string>("Connecting...");

  const channelRef = useRef<RealtimeChannel | null>(null);
  const autoScanRef = useRef(false);

  const title = useMemo(() => {
    const tc = snapshot?.terminal?.terminal_code;
    return tc ? `Customer Display — ${tc}` : "Customer Display";
  }, [snapshot]);

  useEffect(() => {
    if (!POS_SIM_ENABLED) return;

    let mounted = true;

    async function fetchSnapshotByCode(code: string) {
      const { data, error } = await supabase
        .from("pos_sim_sessions")
        .select("session_id, snapshot_json")
        .eq("session_code", code)
        .maybeSingle();

      if (error) throw error;
      if (!data?.session_id) throw new Error("Session not found or expired");

      return {
        sid: String(data.session_id),
        snap: data.snapshot_json as PosSimSnapshot,
      };
    }

    async function run() {
      setLoading(true);
      setStatus("Loading session...");

      try {
        const { sid, snap } = await fetchSnapshotByCode(sessionCode);

        if (!mounted) return;
        setSessionId(sid);
        setSnapshot(snap);
        setStatus("Connecting realtime...");

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

        ch.subscribe(async (st: SubscribeStatus) => {
          if (!mounted) return;

          if (st === "SUBSCRIBED") {
            setStatus("Live");

            const joinEv = makeEvent("CUSTOMER_JOINED", sid, {
              session_code: sessionCode,
            } satisfies JsonObject);

            await ch.send({
              type: "broadcast",
              event: "pos_sim",
              payload: joinEv,
            });

            // Safety refresh
            try {
              const refreshed = await fetchSnapshotByCode(sessionCode);
              if (mounted) {
                setSessionId(refreshed.sid);
                setSnapshot(refreshed.snap);
              }
            } catch (e: unknown) {
              if (mounted) setStatus(`Live (refresh warning): ${toStatus(e)}`);
            }

            return;
          }

          if (st === "TIMED_OUT") setStatus("Realtime timed out");
          if (st === "CHANNEL_ERROR") setStatus("Realtime channel error");
          if (st === "CLOSED") setStatus("Realtime closed");
        });
      } catch (e: unknown) {
        const msg = toStatus(e);
        console.error("Customer display load failed:", e);
        if (!mounted) return;
        setStatus(msg);
        setSnapshot(null);
        setSessionId(null);
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
  }, [sessionCode, supabase]);

  async function broadcastScan(outcome: "success" | "fail") {
    const sid = sessionId;
    const ch = channelRef.current;
    if (!sid || !ch) return;

    const message =
      outcome === "success"
        ? "Receipt linked to wallet (simulated)."
        : "Scan failed (simulated).";

    const ev = makeEvent("CUSTOMER_SCANNED", sid, {
      outcome,
      message,
      session_code: sessionCode,
    } satisfies JsonObject);

    await ch.send({ type: "broadcast", event: "pos_sim", payload: ev });
  }

  // Auto scan simulation
  useEffect(() => {
    if (!snapshot) return;
    const receiptUrl = snapshot.receipt?.public_url ?? null;
    if (!receiptUrl) return;

    const mode = snapshot.toggles.customer_scan_sim ?? "none";
    if (mode === "none") return;

    if (autoScanRef.current) return;

    const scanState = snapshot.scan?.state ?? "NONE";
    if (scanState === "SUCCESS" || scanState === "FAIL") return;

    autoScanRef.current = true;

    const outcome = mode === "auto_success" ? "success" : "fail";
    const delay = 1200;

    const t = window.setTimeout(() => {
      void broadcastScan(outcome);
    }, delay);

    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.receipt?.public_url, snapshot?.toggles?.customer_scan_sim]);

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

  const receiptUrl = snapshot?.receipt?.public_url ?? null;
  const scanState = snapshot?.scan?.state ?? "NONE";

  const canScan =
    !!receiptUrl &&
    !(scanState === "SUCCESS" || scanState === "FAIL") &&
    status === "Live";

  function scanOutcomeFromToggle(): "success" | "fail" {
    const mode = snapshot?.toggles.customer_scan_sim ?? "none";
    if (mode === "auto_fail") return "fail";
    if (mode === "auto_success") return "success";
    return "success"; // manual default
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
            No snapshot loaded. Session may be expired or access is blocked
            (check Status above).
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

                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
                  Scan
                </div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{scanState}</div>
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
                  {receiptUrl
                    ? "Scan the QR to receive your receipt."
                    : "Waiting for receipt issuance."}
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
                    disabled={!canScan}
                    onClick={() => {
                      const outcome = scanOutcomeFromToggle();
                      void broadcastScan(outcome);
                    }}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "1px solid #111",
                      background: canScan ? "#111" : "#fff",
                      color: canScan ? "#fff" : "#111",
                      fontWeight: 900,
                      opacity: canScan ? 1 : 0.5,
                    }}
                  >
                    Simulate Scan
                  </button>

                  <div
                    style={{
                      fontSize: 12,
                      opacity: 0.7,
                      alignSelf: "center",
                    }}
                  >
                    Toggle drives outcome:{" "}
                    <b>{snapshot.toggles.customer_scan_sim ?? "none"}</b>
                  </div>
                </div>
              </div>
            </div>

            <div
              style={{
                marginTop: 16,
                padding: 14,
                border: "1px solid #eee",
                borderRadius: 12,
              }}
            >
              <div style={{ fontWeight: 900, fontSize: 14 }}>Your Receipt</div>

              {!receiptUrl ? (
                <div style={{ marginTop: 8, opacity: 0.85 }}>
                  {snapshot.flow.payment_state === "APPROVED"
                    ? "Payment approved. Issuing receipt…"
                    : "Complete payment to generate your receipt."}
                </div>
              ) : (
                <div
                  style={{
                    marginTop: 10,
                    display: "flex",
                    gap: 14,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <Image
                    src={makeQrUrl(receiptUrl)}
                    alt="Receipt QR"
                    width={300}
                    height={300}
                    unoptimized
                    referrerPolicy="no-referrer"
                    style={{ borderRadius: 12, border: "1px solid #eee" }}
                  />
                  <div style={{ flex: 1, minWidth: 260 }}>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>
                      Receipt link
                    </div>
                    <a
                      href={receiptUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ wordBreak: "break-all" }}
                    >
                      {receiptUrl}
                    </a>

                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                      Token
                    </div>
                    <div style={{ fontFamily: "monospace" }}>
                      {snapshot.receipt?.token_id ?? "—"}
                    </div>

                    {snapshot.scan?.message && (
                      <>
                        <div
                          style={{
                            marginTop: 10,
                            fontSize: 12,
                            opacity: 0.75,
                          }}
                        >
                          Scan message
                        </div>
                        <div style={{ opacity: 0.9 }}>
                          {snapshot.scan.message}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
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
