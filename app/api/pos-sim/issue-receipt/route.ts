import { NextResponse } from "next/server";
import crypto from "crypto";

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
  sale_id?: string;
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

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

/* ---------------------------
   RL-030 signing (Node)
---------------------------- */
function sha256HexUtf8(input: string) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function hmacB64url(secret: string, msg: string) {
  const b64 = crypto
    .createHmac("sha256", secret)
    .update(msg, "utf8")
    .digest("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function nonceB64url(bytes = 18) {
  const b64 = crypto.randomBytes(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function buildSupabaseFunctionUrl(base: string, fnName: string) {
  const b = base.replace(/\/+$/, "");
  if (/\.functions\.supabase\.co$/i.test(new URL(b).hostname)) {
    return `${b}/${fnName}`;
  }
  return `${b}/functions/v1/${fnName}`;
}

export async function POST(req: Request) {
  try {
    const enabled =
      isOn(process.env.POS_SIM_ENABLED) ||
      isOn(process.env.NEXT_PUBLIC_POS_SIM_ENABLED);
    if (!enabled) return bad(404, "POS simulator not enabled");

    const supabaseBase =
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey =
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;

    if (!supabaseBase)
      return bad(500, "Missing SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL");
    if (!anonKey)
      return bad(500, "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");

    const terminalKey = process.env.TERMINAL_KEY_TEST_001;
    if (!terminalKey)
      return bad(500, "Missing TERMINAL_KEY_TEST_001 in Vercel env");

    const RL_SECRET = process.env.RL_SIGNING_SECRET;
    if (!RL_SECRET)
      return bad(500, "Missing RL_SIGNING_SECRET in Vercel env");

    const ingestUrl = buildSupabaseFunctionUrl(
      supabaseBase,
      "receipt-ingest"
    );

    const bodyUnknown: unknown = await req.json().catch(() => null);
    if (!bodyUnknown || typeof bodyUnknown !== "object") {
      return bad(400, "Invalid JSON body");
    }

    const b = bodyUnknown as Record<string, unknown>;

    const retailer_id = asNonEmptyString(b.retailer_id);
    const store_id = asNonEmptyString(b.store_id);
    const terminal_code = asNonEmptyString(b.terminal_code);

    if (!store_id || !terminal_code || !retailer_id) {
      return bad(400, "Missing store_id / terminal_code / retailer_id");
    }

    if (!Array.isArray(b.items) || b.items.length === 0) {
      return bad(400, "items must not be empty");
    }

    const sale_id =
      asNonEmptyString(b.sale_id) ??
      asNonEmptyString(b.active_sale_id) ??
      asNonEmptyString(b.session_id) ??
      `SIM-${Date.now()}`;

    const cleaned: Body = {
      ...(b as Body),
      retailer_id,
      store_id,
      terminal_code,
      sale_id,
    };

    /* ==========================
       RL-030 canonical signing
    ========================== */
    const rawBody = JSON.stringify(cleaned);
    const ts = Date.now().toString();
    const nonce = nonceB64url();
    const bodyHash = sha256HexUtf8(rawBody);

    const urlPath = new URL(ingestUrl).pathname;
    const fnName = urlPath.split("/").filter(Boolean).pop() ?? "receipt-ingest";
    const path = `/${fnName}`;

    const canonical = `RL1\nPOST\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
    const sig = hmacB64url(RL_SECRET, canonical);

    const debug = req.headers.get("x-rl-debug") === "1";

    const res = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "x-terminal-key": terminalKey,
        "x-rl-ts": ts,
        "x-rl-nonce": nonce,
        "x-rl-body-sha256": bodyHash,
        "x-rl-sig": sig,
      },
      body: rawBody,
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    /* ==========================
       TEMP DEBUG ECHO (REMOVE)
    ========================== */
function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : { value: v };
}

    
    if (!res.ok) {
      return bad(502, "receipt-ingest returned non-2xx", {
        ...asObject(parsed),
        ...(debug
          ? {
              _rl_debug: {
                ingestUrl,
                path,
                ts,
                nonce,
                bodyHash,
                sig,
                rawBody,
              },
            }
          : {}),
      });
    }

    return NextResponse.json(
      {
        ...asObject(parsed),
        ...(debug
          ? {
              _rl_debug: {
                ingestUrl,
                path,
                ts,
                nonce,
                bodyHash,
                sig,
                rawBody,
              },
            }
          : {}),
      },
      { status: 200 }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return bad(500, "Unhandled error", msg);
  }
}
