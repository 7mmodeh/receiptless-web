// app/r/[tokenId]/page.tsx
import React from "react";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type ReceiptItem = {
  name?: string | null;
  sku?: string | null;
  qty?: number | null;
  unit_price?: number | null;
  total?: number | null;
  vat_rate?: number | null;
};

type TokenPreviewResponse = {
  receipt?: {
    issued_at?: string | null;
    currency?: string | null; // e.g. "EUR"
    subtotal?: number | null;
    vat_total?: number | null;
    total?: number | null;
    items?: ReceiptItem[] | null;
  } | null;

  token?: {
    status?: string | null; // e.g. "active" | "consumed" | "expired" | ...
    consumed_at?: string | null;
  } | null;

  status?: string | null;
  consumed_at?: string | null;
};

type FetchError = {
  message: string;
  status?: number;
};

// IMPORTANT: no /g flag here (global regex makes .test() stateful).
const UUID_VALIDATE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const UUID_EXTRACT_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

function isValidUuid(value: string) {
  return UUID_VALIDATE_RE.test(value);
}

function formatDateTime(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IE", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function formatMoney(amount?: number | null, currency?: string | null) {
  if (amount == null || Number.isNaN(amount)) return "—";
  const cur = currency || "EUR";
  try {
    return new Intl.NumberFormat("en-IE", {
      style: "currency",
      currency: cur,
      currencyDisplay: "symbol",
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${cur}`;
  }
}

function getFunctionsBaseUrl() {
  const base = process.env.NEXT_PUBLIC_FUNCTIONS_BASE_URL;
  return (base || "").replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringField(
  obj: Record<string, unknown>,
  key: string
): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

function getNumberField(
  obj: Record<string, unknown>,
  key: string
): number | null {
  const v = obj[key];
  return typeof v === "number" ? v : null;
}

function coerceFetchError(e: unknown, fallbackMessage: string): FetchError {
  if (e instanceof Error) return { message: e.message || fallbackMessage };

  if (isRecord(e)) {
    const msg = getStringField(e, "message");
    const status = getNumberField(e, "status") ?? undefined;
    if (msg) return { message: msg, status };
  }

  return { message: fallbackMessage };
}

async function tryFetchJson(url: string): Promise<TokenPreviewResponse> {
  const controller = new AbortController();
  const timeoutMs = 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw coerceFetchError(e, "Request timed out or network error");
  } finally {
    clearTimeout(timer);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`Unexpected response content-type (${contentType})`);
  }

  const data = (await res.json()) as unknown;

  if (!res.ok) {
    let msg: string | null = null;
    if (isRecord(data)) {
      msg = getStringField(data, "error") ?? getStringField(data, "message");
    }
    const message = msg || `Request failed (${res.status})`;
    const err: FetchError = { message, status: res.status };
    throw err;
  }

  return data as TokenPreviewResponse;
}

async function fetchTokenPreview(
  tokenId: string
): Promise<TokenPreviewResponse> {
  const base = getFunctionsBaseUrl();
  if (!base) throw new Error("Missing NEXT_PUBLIC_FUNCTIONS_BASE_URL");

  const candidates = [
    `${base}/token-preview?tokenId=${encodeURIComponent(tokenId)}`,
    `${base}/token-preview?token_id=${encodeURIComponent(tokenId)}`,
    `${base}/token-preview?id=${encodeURIComponent(tokenId)}`,
    `${base}/token-preview/${encodeURIComponent(tokenId)}`,
  ];

  let lastError: FetchError | null = null;

  for (const url of candidates) {
    try {
      return await tryFetchJson(url);
    } catch (e) {
      lastError = coerceFetchError(e, "Failed to load token preview");
      if (lastError.status && lastError.status !== 404) break;
    }
  }

  throw new Error(lastError?.message || "Failed to load token preview");
}

function normalizeTokenStatus(data: TokenPreviewResponse) {
  const status = data?.token?.status ?? data?.status ?? null;
  const consumedAt = data?.token?.consumed_at ?? data?.consumed_at ?? null;
  return { status, consumedAt };
}

function getQueryToken(
  searchParams?: Record<string, string | string[] | undefined>
) {
  if (!searchParams) return null;

  const pick = (key: string) => {
    const v = searchParams[key];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
    return null;
  };

  return pick("tokenId") ?? pick("token_id") ?? pick("id");
}

/**
 * Normalizes any incoming token string:
 * - decodeURIComponent safely
 * - replace Unicode hyphens with ASCII '-'
 * - strip zero-width/invisible characters
 * - extract UUID substring
 */
function normalizeIncomingToken(rawValue: string): string {
  let s = rawValue.trim();

  // Decode defensively
  try {
    s = decodeURIComponent(s);
  } catch {
    // ignore
  }

  // Replace common Unicode hyphens/dashes with ASCII hyphen
  s = s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-");

  // Strip zero-width characters (copy/paste artifacts)
  s = s.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, "");

  // Extract UUID substring
  const m = s.match(UUID_EXTRACT_RE);
  return (m?.[0] ?? "").trim();
}

export default async function ReceiptTokenPage({
  params,
  searchParams,
}: {
  params: { tokenId?: string };
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  // Primary: /r/<tokenId>
  const tokenId = normalizeIncomingToken(String(params?.tokenId ?? ""));

  // Fallback: /r?tokenId=<uuid> -> redirect to canonical /r/<uuid>
  if (!tokenId) {
    const q = normalizeIncomingToken(String(getQueryToken(searchParams) ?? ""));
    if (q && isValidUuid(q)) {
      redirect(`/r/${q}`);
    }
  }

  if (!isValidUuid(tokenId)) {
    return (
      <main style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.h1}>INVALID-LINK-MARKER__A9F2__DO-NOT-REMOVE</h1>
          <p style={styles.p}>
            This receipt link is not valid. Please check the URL and try again.
          </p>
        </div>
      </main>
    );
  }

  let data: TokenPreviewResponse | null = null;
  let errorMessage: string | null = null;

  try {
    data = await fetchTokenPreview(tokenId);
  } catch (e) {
    const err = coerceFetchError(
      e,
      "We couldn't load this receipt right now. Please try again."
    );
    errorMessage = err.message;
  }

  if (errorMessage || !data) {
    return (
      <main style={styles.page}>
        <div style={styles.card}>
          <div style={styles.headerRow}>
            <h1 style={styles.h1}>Receipt</h1>
            <a href={`receiptless://r/${tokenId}`} style={styles.primaryBtn}>
              Open in app
            </a>
          </div>

          <div style={styles.divider} />

          <div style={styles.bannerError}>
            <strong>Unable to load receipt</strong>
            <div style={{ marginTop: 6, opacity: 0.9 }}>{errorMessage}</div>
          </div>

          <p style={{ ...styles.p, marginTop: 14, color: "rgba(0,0,0,0.65)" }}>
            If the problem persists, request a fresh link from the merchant.
          </p>
        </div>
      </main>
    );
  }

  const receipt = data.receipt ?? null;
  const items = (receipt?.items ?? []) as ReceiptItem[];

  const { status, consumedAt } = normalizeTokenStatus(data);
  const normalizedStatus = (status || "").toLowerCase();
  const isConsumed =
    normalizedStatus === "consumed" ||
    normalizedStatus === "used" ||
    normalizedStatus === "already_used";

  const isInactive =
    isConsumed ||
    (normalizedStatus &&
      normalizedStatus !== "active" &&
      normalizedStatus !== "valid");

  const currency = receipt?.currency ?? "EUR";

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <div style={styles.headerRow}>
          <div>
            <h1 style={styles.h1}>Receipt</h1>
            <div style={styles.subtle}>Token: {tokenId}</div>
          </div>

          <a href={`receiptless://r/${tokenId}`} style={styles.primaryBtn}>
            Open in app
          </a>
        </div>

        {isInactive ? (
          <div style={isConsumed ? styles.bannerConsumed : styles.bannerWarn}>
            <div style={{ fontWeight: 700 }}>
              {isConsumed
                ? "Consumed / Already used"
                : "This token is not active"}
            </div>
            <div style={{ marginTop: 6, opacity: 0.95 }}>
              {isConsumed ? (
                <>
                  Consumed at: <strong>{formatDateTime(consumedAt)}</strong>
                </>
              ) : (
                <>
                  Status: <strong>{status || "unknown"}</strong>
                  {consumedAt ? (
                    <>
                      {" "}
                      • Consumed at:{" "}
                      <strong>{formatDateTime(consumedAt)}</strong>
                    </>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ) : null}

        <div style={styles.divider} />

        <section style={styles.section}>
          <div style={styles.kvGrid}>
            <div style={styles.kv}>
              <div style={styles.k}>Issued</div>
              <div style={styles.v}>{formatDateTime(receipt?.issued_at)}</div>
            </div>
            <div style={styles.kv}>
              <div style={styles.k}>Currency</div>
              <div style={styles.v}>{currency}</div>
            </div>
            <div style={styles.kv}>
              <div style={styles.k}>Subtotal</div>
              <div style={styles.v}>
                {formatMoney(receipt?.subtotal, currency)}
              </div>
            </div>
            <div style={styles.kv}>
              <div style={styles.k}>VAT</div>
              <div style={styles.v}>
                {formatMoney(receipt?.vat_total, currency)}
              </div>
            </div>
            <div style={styles.kv}>
              <div style={styles.k}>Total</div>
              <div style={{ ...styles.v, fontWeight: 800 }}>
                {formatMoney(receipt?.total, currency)}
              </div>
            </div>
          </div>
        </section>

        <div style={styles.divider} />

        <section style={styles.section}>
          <h2 style={styles.h2}>Items</h2>

          {items.length === 0 ? (
            <p style={styles.p}>No items found on this receipt.</p>
          ) : (
            <div
              style={styles.tableWrap}
              role="table"
              aria-label="Receipt items"
            >
              <div style={styles.tableHeader} role="row">
                <div style={{ ...styles.th, flex: 2 }} role="columnheader">
                  Item
                </div>
                <div
                  style={{ ...styles.th, flex: 0.6, textAlign: "right" }}
                  role="columnheader"
                >
                  Qty
                </div>
                <div
                  style={{ ...styles.th, flex: 1, textAlign: "right" }}
                  role="columnheader"
                >
                  Unit
                </div>
                <div
                  style={{ ...styles.th, flex: 1, textAlign: "right" }}
                  role="columnheader"
                >
                  Line total
                </div>
              </div>

              {items.map((it, idx) => {
                const name = it?.name ?? it?.sku ?? `Item ${idx + 1}`;
                const qty = it?.qty ?? 1;
                const unitPrice = it?.unit_price ?? null;
                const lineTotal =
                  it?.total ??
                  (unitPrice != null ? unitPrice * (qty || 1) : null);

                return (
                  <div key={idx} style={styles.tr} role="row">
                    <div style={{ ...styles.td, flex: 2 }} role="cell">
                      <div style={{ fontWeight: 650 }}>{name}</div>
                      {it?.sku ? (
                        <div style={styles.subtleSmall}>SKU: {it.sku}</div>
                      ) : null}
                      {it?.vat_rate != null ? (
                        <div style={styles.subtleSmall}>
                          VAT rate: {it.vat_rate}%
                        </div>
                      ) : null}
                    </div>

                    <div
                      style={{ ...styles.td, flex: 0.6, textAlign: "right" }}
                      role="cell"
                    >
                      {qty ?? "—"}
                    </div>

                    <div
                      style={{ ...styles.td, flex: 1, textAlign: "right" }}
                      role="cell"
                    >
                      {formatMoney(unitPrice, currency)}
                    </div>

                    <div
                      style={{
                        ...styles.td,
                        flex: 1,
                        textAlign: "right",
                        fontWeight: 700,
                      }}
                      role="cell"
                    >
                      {formatMoney(lineTotal, currency)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <div style={styles.footerNote}>
          If the deep link does not open, ensure the Receiptless app is
          installed and try again.
        </div>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    padding: "24px 16px",
    background: "#f6f7f9",
    display: "flex",
    justifyContent: "center",
  },
  card: {
    width: "100%",
    maxWidth: 880,
    background: "#ffffff",
    border: "1px solid rgba(0,0,0,0.08)",
    borderRadius: 14,
    padding: 18,
    boxShadow: "0 8px 24px rgba(0,0,0,0.06)",
  },
  headerRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  h1: {
    margin: 0,
    fontSize: 22,
    lineHeight: 1.2,
    letterSpacing: -0.2,
  },
  h2: {
    margin: "0 0 12px 0",
    fontSize: 16,
    letterSpacing: -0.1,
  },
  p: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.55,
    color: "rgba(0,0,0,0.82)",
  },
  subtle: {
    marginTop: 6,
    fontSize: 12.5,
    color: "rgba(0,0,0,0.55)",
    wordBreak: "break-all",
  },
  subtleSmall: {
    marginTop: 4,
    fontSize: 12,
    color: "rgba(0,0,0,0.55)",
  },
  divider: {
    height: 1,
    background: "rgba(0,0,0,0.08)",
    margin: "16px 0",
  },
  section: {
    display: "block",
  },
  kvGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 12,
  },
  kv: {
    background: "rgba(0,0,0,0.02)",
    border: "1px solid rgba(0,0,0,0.06)",
    borderRadius: 12,
    padding: 12,
  },
  k: {
    fontSize: 12,
    color: "rgba(0,0,0,0.55)",
    marginBottom: 6,
  },
  v: {
    fontSize: 14,
    color: "rgba(0,0,0,0.88)",
  },
  primaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 36,
    padding: "0 14px",
    borderRadius: 10,
    textDecoration: "none",
    fontSize: 13.5,
    fontWeight: 700,
    color: "#ffffff",
    background: "#111827",
    border: "1px solid rgba(0,0,0,0.08)",
    whiteSpace: "nowrap",
  },
  bannerConsumed: {
    marginTop: 14,
    padding: 12,
    borderRadius: 12,
    background: "rgba(239, 68, 68, 0.10)",
    border: "1px solid rgba(239, 68, 68, 0.25)",
    color: "rgba(0,0,0,0.86)",
  },
  bannerWarn: {
    marginTop: 14,
    padding: 12,
    borderRadius: 12,
    background: "rgba(245, 158, 11, 0.12)",
    border: "1px solid rgba(245, 158, 11, 0.25)",
    color: "rgba(0,0,0,0.86)",
  },
  bannerError: {
    padding: 12,
    borderRadius: 12,
    background: "rgba(239, 68, 68, 0.10)",
    border: "1px solid rgba(239, 68, 68, 0.25)",
    color: "rgba(0,0,0,0.86)",
  },
  tableWrap: {
    border: "1px solid rgba(0,0,0,0.08)",
    borderRadius: 12,
    overflow: "hidden",
  },
  tableHeader: {
    display: "flex",
    gap: 10,
    padding: "10px 12px",
    background: "rgba(0,0,0,0.03)",
    borderBottom: "1px solid rgba(0,0,0,0.08)",
  },
  th: {
    fontSize: 12,
    fontWeight: 800,
    color: "rgba(0,0,0,0.70)",
  },
  tr: {
    display: "flex",
    gap: 10,
    padding: "12px",
    borderBottom: "1px solid rgba(0,0,0,0.06)",
  },
  td: {
    fontSize: 13.5,
    color: "rgba(0,0,0,0.86)",
  },
  footerNote: {
    marginTop: 14,
    fontSize: 12.5,
    color: "rgba(0,0,0,0.55)",
  },
};
