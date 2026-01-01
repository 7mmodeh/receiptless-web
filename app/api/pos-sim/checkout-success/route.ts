import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type ReceiptItemInput = {
  line_no: number;
  sku?: string | null;
  name: string;
  qty: number;
  unit_price: number;
  line_total: number;
  vat_rate?: number | null;
  vat_amount?: number | null;
};

type ReceiptIngestPayload = {
  retailer_id: string;
  store_id: string;
  terminal_code: string;

  issued_at: string; // ISO string
  receipt_number?: string | null;

  currency: string;
  subtotal: number;
  vat_total: number;
  total: number;

  items: ReceiptItemInput[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function getString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function posSimEnabled(): boolean {
  const v = (process.env.POS_SIM_ENABLED ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/**
 * POS Simulator backend endpoint (DEMO ONLY).
 * Returns 404 unless POS_SIM_ENABLED=true.
 */
export async function POST(req: Request) {
  if (!posSimEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const body = (await req.json().catch(() => null)) as unknown;
    if (!isRecord(body)) {
      return NextResponse.json(
        { error: "Invalid JSON", fallback: "PRINT_RECEIPT" },
        { status: 400 }
      );
    }

    const payload = body as unknown as ReceiptIngestPayload;

    const ingestUrl = process.env.RECEIPTLESS_INGEST_URL?.trim();
    const terminalKey = process.env.TERMINAL_KEY_TEST_001?.trim(); // simulator key only

    if (!ingestUrl) {
      return NextResponse.json(
        { error: "Missing RECEIPTLESS_INGEST_URL env", fallback: "PRINT_RECEIPT" },
        { status: 500 }
      );
    }
    if (!terminalKey) {
      return NextResponse.json(
        { error: "Missing TERMINAL_KEY_TEST_001 env", fallback: "PRINT_RECEIPT" },
        { status: 500 }
      );
    }

    if (
      !payload?.retailer_id ||
      !payload?.store_id ||
      !payload?.terminal_code ||
      !payload?.issued_at ||
      !payload?.currency ||
      !Array.isArray(payload?.items) ||
      payload.items.length === 0
    ) {
      return NextResponse.json(
        { error: "Missing required fields", fallback: "PRINT_RECEIPT" },
        { status: 400 }
      );
    }

    // Fail fast so POS can print quickly
    const controller = new AbortController();
    const timeoutMs = 4000;
    const t = setTimeout(() => controller.abort(), timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(ingestUrl, {
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
    } finally {
      clearTimeout(t);
    }

    const data = (await resp.json().catch(() => null)) as unknown;

    if (!resp.ok) {
      const msg =
        (isRecord(data) && (getString(data["error"]) || getString(data["message"]))) ||
        `receipt-ingest failed (${resp.status})`;

      return NextResponse.json(
        { error: "Receiptless unavailable", details: msg, fallback: "PRINT_RECEIPT" },
        { status: 502 }
      );
    }

    if (!isRecord(data)) {
      return NextResponse.json(
        { error: "Invalid response from receipt-ingest", fallback: "PRINT_RECEIPT" },
        { status: 502 }
      );
    }

    const token_id = getString(data["token_id"]);
    const public_url = getString(data["public_url"]);

    if (!token_id || !public_url) {
      return NextResponse.json(
        { error: "Missing token_id/public_url", fallback: "PRINT_RECEIPT" },
        { status: 502 }
      );
    }

    return NextResponse.json(
      {
        token_id,
        public_url,
        qr_url: getString(data["qr_url"]) ?? public_url,
        preview_url: getString(data["preview_url"]),
      },
      { status: 200 }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "Backend error", details: msg, fallback: "PRINT_RECEIPT" },
      { status: 500 }
    );
  }
}
