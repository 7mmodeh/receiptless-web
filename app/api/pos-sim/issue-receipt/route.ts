// app/api/pos-sim/issue-receipt/route.ts

import { NextResponse } from "next/server";

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

type Body = {
  retailer_id: string;
  store_id: string;
  terminal_code: string;

  issued_at: string; // ISO
  receipt_number?: string | null;

  currency: string;
  subtotal: number;
  vat_total: number;
  total: number;

  items: ReceiptItemInput[];
};

function isOn(v: string | undefined) {
  const s = (v ?? "").toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function bad(status: number, error: string, details?: unknown) {
  return NextResponse.json({ error, ...(details ? { details } : {}) }, { status });
}

export async function POST(req: Request) {
  try {
    // Gate demo
    const enabled =
      isOn(process.env.POS_SIM_ENABLED) || isOn(process.env.NEXT_PUBLIC_POS_SIM_ENABLED);
    if (!enabled) return bad(404, "POS simulator not enabled");

    // Required envs
    const supabaseUrl =
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey =
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl) return bad(500, "Missing SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL");
    if (!anonKey) return bad(500, "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");

    // Your deployed secret in Vercel env
    const terminalKey = process.env.TERMINAL_KEY_TEST_001;
    if (!terminalKey) return bad(500, "Missing TERMINAL_KEY_TEST_001 in Vercel env");

    const ingestUrl = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/receipt-ingest`;

    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body) return bad(400, "Invalid JSON body");

    // Minimal validation (the edge function validates strongly anyway)
    if (!body.store_id || !body.terminal_code || !body.retailer_id) {
      return bad(400, "Missing store_id / terminal_code / retailer_id");
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return bad(400, "items must not be empty");
    }

    const res = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // recommended for edge functions:
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        // terminal auth:
        "x-terminal-key": terminalKey,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      return bad(502, "receipt-ingest returned non-2xx", parsed);
    }

    return NextResponse.json(parsed, { status: 200 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return bad(500, "Unhandled error", msg);
  }
}
