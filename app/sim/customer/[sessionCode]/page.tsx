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
  const [scanSendStatus, setScanSendStatus] = useState<string>("");

  const channelRef = useRef<RealtimeChannel | null>(null);

  // Prevent repeated auto-scan for the same receipt token
  const lastAutoScanTokenRef = useRef<string | null>(null);
  const autoScanTimerRef = useRef<number | null>(null);

  const title = useMemo(() => {
    const tc = snapshot?.terminal?.terminal_code;
    return tc ? `Customer Display — ${tc}` : "Customer Display";
  }, [snapshot]);

  function canSendScan(): boolean {
    if (!snapshot) return false;
    if (!sessionId) return false;
    if (!channelRef.current) return false;
    const tokenId = snapshot.receipt?.token_id ?? null;
    if (!tokenId) return false;

    // If host already recorded a terminal scan result, do not re-send
    const scanState = snapshot.scan?.state ?? "NONE";
    if (scanState === "SUCCESS" || scanState === "FAIL") return false;

    // Only meaningful when token exists; allow while PENDING / NONE
    return true;
  }

  async function sendScan(outcome: "success" | "fail") {
    const ch = channelRef.current;
    const snap = snapshot;
    const sid = sessionId;

    if (!ch || !snap || !sid) return;

    const tokenId = snap.receipt?.token_id ?? null;
    if (!tokenId) return;

    // If host already recorded a terminal scan result, do not re-send
    const scanState = snap.scan?.state ?? "NONE";
    if (scanState === "SUCCESS" || scanState === "FAIL") return;

    setScanSendStatus("Sending scan…");

    const message =
      outcome === "success"
        ? "Receipt linked to wallet (simulated)."
        : "Scan failed (simulated).";

    const ev = makeEvent("CUSTOMER_SCANNED", sid, {
      outcome,
      message,
      token_id: tokenId,
    } satisfies JsonObject);

    try {
      const res = await ch.send({
        type: "broadcast",
        event: "pos_sim",
        payload: ev,
      });

      if (res === "ok") {
        setScanSendStatus(
          outcome === "success" ? "Scan sent: success" : "Scan sent: fail"
        );
      } else {
        setScanSendStatus(`Scan send error: ${String(res)}`);
      }
    } catch (e: unknown) {
      setScanSendStatus(`Scan send error: ${toStatus(e)}`);
    } finally {
      window.setTimeout(() => setScanSendStatus(""), 1500);
    }
  }

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

      if (autoScanTimerRef.current) {
        window.clearTimeout(autoScanTimerRef.current);
        autoScanTimerRef.current = null;
      }

      const ch = channelRef.current;
      channelRef.current = null;
      if (ch) supabase.removeChannel(ch);
    };
  }, [sessionCode, supabase]);

  // Customer scan simulation (auto):
  // When receipt token is ready and toggle requests auto scan, broadcast CUSTOMER_SCANNED once per token.
  useEffect(() => {
    const ch = channelRef.current;
    if (!ch) return;
    if (!snapshot) return;
    if (!sessionId) return;

    const tokenId = snapshot.receipt?.token_id ?? null;
    const sim = snapshot.toggles?.customer_scan_sim ?? "none";
    const scanState = snapshot.scan?.state ?? "NONE";

    if (!tokenId) return;
    if (sim === "none") return;

    // If host already recorded a terminal scan result, do not re-send
    if (scanState === "SUCCESS" || scanState === "FAIL") return;

    // Prevent repeating for same token
    if (lastAutoScanTokenRef.current === tokenId) return;
    lastAutoScanTokenRef.current = tokenId;

    if (autoScanTimerRef.current) {
      window.clearTimeout(autoScanTimerRef.current);
      autoScanTimerRef.current = null;
    }

    autoScanTimerRef.current = window.setTimeout(async () => {
      const outcome = sim === "auto_success" ? "success" : "fail";
      const message =
        outcome === "success"
          ? "Receipt linked to wallet (simulated)."
          : "Scan failed (simulated).";

      const ev = makeEvent("CUSTOMER_SCANNED", sessionId, {
        outcome,
        message,
        token_id: tokenId,
      } satisfies JsonObject);

      try {
        await ch.send({
          type: "broadcast",
          event: "pos_sim",
          payload: ev,
        });
      } catch {
        // Ignore; host will still be able to continue demo via manual scan buttons.
      }
    }, 1200);
  }, [
    snapshot?.receipt?.token_id,
    snapshot?.toggles?.customer_scan_sim,
    snapshot?.scan?.state,
    sessionId,
    snapshot,
  ]);

  // Reset auto-scan “seen token” when a new sale starts / receipt cleared
  useEffect(() => {
    const tokenId = snapshot?.receipt?.token_id ?? null;
    if (!tokenId) {
      lastAutoScanTokenRef.current = null;
      if (autoScanTimerRef.current) {
        window.clearTimeout(autoScanTimerRef.current);
        autoScanTimerRef.current = null;
      }
    }
  }, [snapshot?.receipt?.token_id]);

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
  const scanState = snapshot?.scan?.state ?? "—";
  const tokenId = snapshot?.receipt?.token_id ?? null;

  const showScanControls = !!snapshot && !!receiptUrl && canSendScan();

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

                {showScanControls && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>
                      Demo control: simulate customer scan
                    </div>
                    <div
                      style={{
                        marginTop: 8,
                        display: "flex",
                        gap: 10,
                        flexWrap: "wrap",
                        alignItems: "center",
                      }}
                    >
                      <button
                        onClick={() => void sendScan("success")}
                        style={{
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: "1px solid #0a7",
                          background: "white",
                          fontWeight: 800,
                        }}
                      >
                        Simulate Scan Success
                      </button>
                      <button
                        onClick={() => void sendScan("fail")}
                        style={{
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: "1px solid #c33",
                          background: "white",
                          fontWeight: 800,
                        }}
                      >
                        Simulate Scan Fail
                      </button>
                      {scanSendStatus ? (
                        <span style={{ fontSize: 12, opacity: 0.8 }}>
                          {scanSendStatus}
                        </span>
                      ) : null}
                    </div>

                    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                      Token:{" "}
                      <span style={{ fontFamily: "monospace" }}>
                        {tokenId ?? "—"}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Receipt panel */}
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

                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                      Scan status
                    </div>
                    <div style={{ fontWeight: 700 }}>
                      {snapshot.scan?.state ?? "—"}
                      {snapshot.scan?.message
                        ? ` — ${snapshot.scan.message}`
                        : ""}
                    </div>
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
