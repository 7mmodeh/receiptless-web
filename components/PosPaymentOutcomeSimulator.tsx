"use client";

import React, { useEffect, useMemo, useState } from "react";
import Image, { ImageLoader } from "next/image";
import type { IssueReceiptBody, PosSimSnapshot } from "@/lib/posSimTypes";

type SnapshotApiOk = { ok: true; snapshot: PosSimSnapshot; updated_at: string };
type SnapshotApiErr = { ok: false; error: string; details?: unknown };

type IssueReceiptResponseStrict = {
  token_id: string;
  public_url: string;
  qr_url: string;
  preview_url: string | null;
};

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "GET" });
  const data: unknown = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (isRecord(data) && "error" in data) {
      throw new Error(String((data as { error: unknown }).error));
    }
    throw new Error(`Request failed: ${res.status}`);
  }

  return data as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data: unknown = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (isRecord(data) && "error" in data) {
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
      "Snapshot missing terminal info (retailer_id/store_id/terminal_code)."
    );
  }

  if (!cart?.currency) {
    throw new Error("Snapshot missing cart.currency.");
  }

  if (!Array.isArray(cart.items) || cart.items.length === 0) {
    throw new Error("Snapshot cart.items is empty; cannot issue receipt.");
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

function makeQrImgUrl(dataUrl: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(
    dataUrl
  )}`;
}

/**
 * next/image requires either:
 *  - remotePatterns/domains in next.config.js, OR
 *  - a custom loader.
 *
 * We use a local loader here so you don't need next.config changes.
 * We also set unoptimized on the QR because it's a dynamic external PNG.
 */
const qrLoader: ImageLoader = ({ src }) => src;

async function copyToClipboard(text: string) {
  if (typeof navigator === "undefined") return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

export function PosPaymentOutcomeSimulator(props: { sessionId: string }) {
  const { sessionId } = props;

  const [snapshot, setSnapshot] = useState<PosSimSnapshot | null>(null);
  const [snapshotUpdatedAt, setSnapshotUpdatedAt] = useState<string | null>(
    null
  );
  const [snapshotBusy, setSnapshotBusy] = useState<boolean>(false);

  const [issueBusy, setIssueBusy] = useState<boolean>(false);
  const [issueResult, setIssueResult] =
    useState<IssueReceiptResponseStrict | null>(null);

  const [error, setError] = useState<string | null>(null);

  const [copied, setCopied] = useState<string | null>(null);

  const canLoad = Boolean(sessionId);
  const canIssue = Boolean(
    sessionId && snapshot && !snapshotBusy && !issueBusy
  );

  const snapshotSummary = useMemo(() => {
    if (!snapshot) return null;
    const t = snapshot.terminal;
    const c = snapshot.cart;
    return {
      retailer_id: t?.retailer_id,
      store_id: t?.store_id,
      terminal_code: t?.terminal_code,
      currency: c?.currency,
      items: c?.items?.length ?? 0,
      total: c?.total,
    };
  }, [snapshot]);

  const receiptUrl = issueResult?.public_url ?? null;
  const qrImgUrl = receiptUrl ? makeQrImgUrl(receiptUrl) : null;

  async function loadSnapshot() {
    if (!sessionId) return;

    setError(null);
    setIssueResult(null);
    setSnapshotBusy(true);

    try {
      const data = await getJson<SnapshotApiOk | SnapshotApiErr>(
        `/api/pos-sim/snapshot?session_id=${encodeURIComponent(sessionId)}`
      );

      if (!data || typeof data !== "object" || !("ok" in data)) {
        throw new Error("Unexpected snapshot API response shape.");
      }

      if (data.ok !== true) {
        throw new Error(
          `Snapshot load failed: ${(data as SnapshotApiErr).error || "Unknown"}`
        );
      }

      const ok = data as SnapshotApiOk;
      setSnapshot(ok.snapshot);
      setSnapshotUpdatedAt(ok.updated_at);
    } catch (e: unknown) {
      setSnapshot(null);
      setSnapshotUpdatedAt(null);
      setError(e instanceof Error ? e.message : "Failed to load snapshot");
    } finally {
      setSnapshotBusy(false);
    }
  }

  async function issueReceiptManual() {
    setError(null);
    setIssueResult(null);
    setIssueBusy(true);

    try {
      if (!snapshot) {
        throw new Error("No snapshot loaded. Click 'Load Snapshot' first.");
      }

      const body = buildIssueReceiptBody(snapshot);

      const resp = await postJson<IssueReceiptResponseStrict>(
        `/api/pos-sim/issue-receipt`,
        body
      );

      // Minimal runtime validation (no guessing)
      if (
        !resp ||
        typeof resp !== "object" ||
        typeof resp.token_id !== "string" ||
        typeof resp.public_url !== "string" ||
        typeof resp.qr_url !== "string" ||
        !("preview_url" in resp)
      ) {
        throw new Error("Unexpected issue-receipt response shape.");
      }

      setIssueResult(resp);
      // // eslint-disable-next-line no-console
      console.log("issue-receipt response:", resp);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Receipt issuance failed");
    } finally {
      setIssueBusy(false);
    }
  }

  async function doCopy(label: string, value: string) {
    try {
      await copyToClipboard(value);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      setCopied(null);
    }
  }

  // Auto-clear state when session changes
  useEffect(() => {
    setSnapshot(null);
    setSnapshotUpdatedAt(null);
    setIssueResult(null);
    setError(null);
    setCopied(null);
  }, [sessionId]);

  return (
    <div className="w-full max-w-5xl space-y-4">
      <div className="rounded-xl border bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm text-gray-600">Session</div>
            <div className="font-mono text-sm break-all">
              {sessionId || "(not set)"}
            </div>
          </div>

          <div className="text-right">
            <div className="text-sm text-gray-600">A6 Mode</div>
            <div className="font-semibold">Snapshot → Issue Receipt</div>
          </div>
        </div>

        {error ? (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">
            <div className="font-semibold">Error</div>
            <div className="text-sm whitespace-pre-wrap">{error}</div>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Snapshot Panel */}
        <div className="rounded-xl border bg-white p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Snapshot (Supabase)</h2>
            <button
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
              onClick={loadSnapshot}
              disabled={!canLoad || snapshotBusy}
              type="button"
              title="Fetch snapshot from /api/pos-sim/snapshot"
            >
              {snapshotBusy ? "Loading…" : "Load Snapshot"}
            </button>
          </div>

          <div className="rounded-lg border bg-gray-50 p-3 text-sm">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold">
                  {snapshot ? "Loaded" : "Not loaded"}
                </div>
                <div className="text-xs text-gray-600">
                  {snapshotUpdatedAt
                    ? `Updated at: ${formatIso(snapshotUpdatedAt)}`
                    : "—"}
                </div>
              </div>
              <div className="text-xs text-gray-600">
                Table:{" "}
                <span className="font-mono">public.pos_sim_snapshots</span>
              </div>
            </div>

            {snapshotSummary ? (
              <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-gray-700">
                <div>
                  Terminal:{" "}
                  <span className="font-mono">
                    {snapshotSummary.retailer_id} / {snapshotSummary.store_id} /{" "}
                    {snapshotSummary.terminal_code}
                  </span>
                </div>
                <div>
                  Cart:{" "}
                  <span className="font-mono">
                    {snapshotSummary.items} items • {snapshotSummary.currency} •
                    total={String(snapshotSummary.total)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="mt-3 text-xs text-gray-600">
                Load snapshot to view terminal/cart summary.
              </div>
            )}
          </div>

          {snapshot ? (
            <details>
              <summary className="cursor-pointer text-sm text-gray-700">
                View raw snapshot JSON
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-2 text-xs">
                {compactJson(snapshot)}
              </pre>
            </details>
          ) : null}
        </div>

        {/* Issue Receipt Panel */}
        <div className="rounded-xl border bg-white p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">A6 — Manual Issue Receipt</h2>
            <button
              className="rounded-lg bg-black px-3 py-1.5 text-sm text-white hover:opacity-95 disabled:opacity-50"
              onClick={issueReceiptManual}
              disabled={!canIssue}
              type="button"
              title="POST /api/pos-sim/issue-receipt using snapshot.terminal + snapshot.cart"
            >
              {issueBusy ? "Issuing…" : "Test Issue Receipt Now"}
            </button>
          </div>

          <div className="text-xs text-gray-600">
            Requires a loaded snapshot (terminal + cart). On success, you’ll get
            a token + public URL to show the receipt.
          </div>

          {issueResult ? (
            <div className="space-y-3">
              {/* QR + Actions */}
              <div className="rounded-xl border bg-gray-50 p-3">
                <div className="text-sm font-semibold">Receipt Ready</div>

                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[240px_1fr]">
                  <div className="rounded-lg border bg-white p-2">
                    <div className="text-xs text-gray-600 mb-2">Receipt QR</div>

                    {qrImgUrl ? (
                      <Image
                        loader={qrLoader}
                        src={qrImgUrl}
                        alt="Receipt QR"
                        width={240}
                        height={240}
                        unoptimized
                        className="block h-[240px] w-[240px]"
                      />
                    ) : (
                      <div className="h-[240px] w-[240px] rounded bg-gray-100" />
                    )}

                    <div className="mt-2 text-[11px] text-gray-500 break-all">
                      Encoded: {receiptUrl}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs text-gray-600">Token</div>
                    <div className="rounded-lg border bg-white p-2 font-mono text-xs break-all">
                      {issueResult.token_id}
                    </div>

                    <div className="text-xs text-gray-600">Public URL</div>
                    <div className="rounded-lg border bg-white p-2 font-mono text-xs break-all">
                      {issueResult.public_url}
                    </div>

                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        type="button"
                        className="rounded-lg border px-3 py-1.5 text-sm hover:bg-white"
                        onClick={() => doCopy("token", issueResult.token_id)}
                      >
                        {copied === "token" ? "Copied" : "Copy Token"}
                      </button>

                      <button
                        type="button"
                        className="rounded-lg border px-3 py-1.5 text-sm hover:bg-white"
                        onClick={() => doCopy("url", issueResult.public_url)}
                      >
                        {copied === "url" ? "Copied" : "Copy URL"}
                      </button>

                      <a
                        className="rounded-lg bg-black px-3 py-1.5 text-sm text-white hover:opacity-95"
                        href={issueResult.public_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open Receipt
                      </a>
                    </div>

                    {issueResult.preview_url ? (
                      <div className="pt-2">
                        <div className="text-xs text-gray-600 mb-1">
                          Preview
                        </div>
                        <iframe
                          title="Receipt preview"
                          src={issueResult.preview_url}
                          className="h-[260px] w-full rounded-lg border bg-white"
                        />
                      </div>
                    ) : (
                      <div className="pt-2 text-xs text-gray-500">
                        preview_url is null (expected in your current response).
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Raw response */}
              <div className="rounded-lg border bg-white p-3">
                <div className="text-xs text-gray-600 mb-2">
                  Raw response (paste this back to me if needed)
                </div>
                <pre className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-2 text-xs">
                  {compactJson(issueResult)}
                </pre>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border bg-gray-50 p-4 text-sm text-gray-700">
              No issuance response yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
