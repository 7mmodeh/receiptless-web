import { NextResponse } from "next/server";

type Body = {
  retailer_id: string;
  store_id: string;
  terminal_code: string;
  token_id: string;
  reason?: string | null;
};

function isOn(v: string | undefined) {
  const s = (v ?? "").toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function bad(status: number, error: string, details?: unknown) {
  return NextResponse.json(
    { error, ...(details ? { details } : {}) },
    { status }
  );
}

export async function POST(req: Request) {
  try {
    const enabled =
      isOn(process.env.POS_SIM_ENABLED) ||
      isOn(process.env.NEXT_PUBLIC_POS_SIM_ENABLED);
    if (!enabled) return bad(404, "POS simulator not enabled");

    const supabaseUrl =
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey =
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
      process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl)
      return bad(500, "Missing SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL");
    if (!anonKey) return bad(500, "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");

    const terminalKey = process.env.TERMINAL_KEY_TEST_001;
    if (!terminalKey)
      return bad(500, "Missing TERMINAL_KEY_TEST_001 in Vercel env");

    const consumeUrl = `${supabaseUrl.replace(
      /\/+$/,
      ""
    )}/functions/v1/receipt-consume`;

    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body) return bad(400, "Invalid JSON body");

    if (
      !body.retailer_id ||
      !body.store_id ||
      !body.terminal_code ||
      !body.token_id
    ) {
      return bad(
        400,
        "Missing retailer_id / store_id / terminal_code / token_id"
      );
    }

    const res = await fetch(consumeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
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
      return bad(502, "receipt-consume returned non-2xx", parsed);
    }

    return NextResponse.json(parsed, { status: 200 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return bad(500, "Unhandled error", msg);
  }
}
