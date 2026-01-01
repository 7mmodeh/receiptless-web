export type ReceiptIngestItem = {
  line_no: number;
  sku?: string | null;
  name?: string | null;
  qty: number;
  unit_price?: number | null;
  line_total: number;
  vat_rate?: number | null;
  vat_amount?: number | null;
};

export type ReceiptIngestPayload = {
  retailer_id: string;
  store_id: string;
  terminal_code: string;

  issued_at: string; // ISO
  receipt_number: string;

  currency: string; // "EUR"
  subtotal: number;
  vat_total: number;
  total: number;

  items: ReceiptIngestItem[];
};

export type ReceiptIngestResponse = {
  token_id: string;
  qr_url?: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function getString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export async function receiptIngest(args: {
  endpointBaseUrl: string; // https://bkfhpmypgerbyrafijwv.supabase.co/functions/v1
  terminalKey: string;     // DO NOT put this in public client for real merchants (see guide)
  payload: ReceiptIngestPayload;
  timeoutMs?: number;
}): Promise<ReceiptIngestResponse> {
  const { endpointBaseUrl, terminalKey, payload, timeoutMs = 8000 } = args;

  const base = endpointBaseUrl.replace(/\/+$/, "");
  const url = `${base}/receipt-ingest`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-terminal-key": terminalKey,
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });

    const ct = res.headers.get("content-type") || "";
    const data: unknown = ct.toLowerCase().includes("application/json")
      ? await res.json()
      : null;

    if (!res.ok) {
      const msg =
        (isRecord(data) && (getString(data["error"]) || getString(data["message"]))) ||
        `receipt-ingest failed (${res.status})`;
      throw new Error(msg);
    }

    if (!isRecord(data)) throw new Error("Invalid receipt-ingest response");

    const token_id = getString(data["token_id"]);
    const qr_url = getString(data["qr_url"]) ?? undefined;

    if (!token_id) throw new Error("Missing token_id in receipt-ingest response");

    return { token_id, qr_url };
  } finally {
    clearTimeout(t);
  }
}
