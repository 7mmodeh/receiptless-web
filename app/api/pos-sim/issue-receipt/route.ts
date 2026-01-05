// app/api/pos-sim/issue-receipt/route.ts

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

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : { value: v };
}

/* ---------------------------
   CORS hardening (RL-040 style)
   - Allowlist Origins via env
   - If Origin present but not allowed -> 403
---------------------------- */
function parseAllowedOrigins(): string[] {
  const raw =
    process.env.POS_SIM_ALLOWED_ORIGINS ??
    process.env.RL_ALLOWED_ORIGINS ??
    process.env.NEXT_PUBLIC_ALLOWED_ORIGINS ??
    "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin: string, allowed: string[]) {
  // Exact match only (keep it strict)
  return allowed.includes(origin);
}

function corsHeadersFor(req: Request) {
  const origin = req.headers.get("origin")?.trim() || null;
  const allowed = parseAllowedOrigins();

  const base: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-rl-debug",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
  };

  // Non-browser/server-to-server calls (no Origin header): no CORS needed.
  if (!origin) return { headers: base, origin: null, allowed: true };

  // If allowlist is empty, default-deny browser origins (enterprise-safe).
  if (allowed.length === 0) return { headers: base, origin, allowed: false };

  if (!isOriginAllowed(origin, allowed)) return { headers: base, origin, allowed: false };

  return {
    headers: {
      ...base,
      "Access-Control-Allow-Origin": origin,
    },
    origin,
    allowed: true,
  };
}

function jsonWithCors(req: Request, status: number, body: unknown) {
  const c = corsHeadersFor(req);
  if (c.origin && !c.allowed) {
    return NextResponse.json(
      { error: "cors_denied", details: { origin: c.origin } },
      { status: 403, headers: c.headers }
    );
  }
  return NextResponse.json(body, { status, headers: c.headers });
}

function bad(req: Request, status: number, error: string, details?: unknown) {
  return jsonWithCors(req, status, { error, ...(details ? { details } : {}) });
}

/* ---------------------------
   RL-030 signing (Node)
---------------------------- */
function sha256HexUtf8(input: string) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function hmacB64url(secret: string, msg: string) {
  const b64 = crypto.createHmac("sha256", secret).update(msg, "utf8").digest("base64");
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

export async function OPTIONS(req: Request) {
  // Respond to preflight with the same CORS allow/deny logic
  const c = corsHeadersFor(req);
  if (c.origin && !c.allowed) {
    return new NextResponse(null, { status: 403, headers: c.headers });
  }
  return new NextResponse(null, { status: 204, headers: c.headers });
}

export async function POST(req: Request) {
  const request_id = crypto.randomUUID();

  try {
    const enabled = isOn(process.env.POS_SIM_ENABLED) || isOn(process.env.NEXT_PUBLIC_POS_SIM_ENABLED);
    if (!enabled) return bad(req, 404, "POS simulator not enabled");

    const supabaseBase = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;

    if (!supabaseBase) return bad(req, 500, "Missing SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL");
    if (!anonKey) return bad(req, 500, "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");

    const terminalKey = process.env.TERMINAL_KEY_TEST_001;
    if (!terminalKey) return bad(req, 500, "Missing TERMINAL_KEY_TEST_001 in env");

    const RL_SECRET = process.env.RL_SIGNING_SECRET;
    if (!RL_SECRET) return bad(req, 500, "Missing RL_SIGNING_SECRET in env");

    const ingestUrl = buildSupabaseFunctionUrl(supabaseBase, "receipt-ingest");

    const bodyUnknown: unknown = await req.json().catch(() => null);
    if (!bodyUnknown || typeof bodyUnknown !== "object") {
      return bad(req, 400, "Invalid JSON body");
    }

    const b = bodyUnknown as Record<string, unknown>;

    const retailer_id = asNonEmptyString(b.retailer_id);
    const store_id = asNonEmptyString(b.store_id);
    const terminal_code = asNonEmptyString(b.terminal_code);

    if (!store_id || !terminal_code || !retailer_id) {
      return bad(req, 400, "Missing store_id / terminal_code / retailer_id");
    }

    if (!Array.isArray(b.items) || b.items.length === 0) {
      return bad(req, 400, "items must not be empty");
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

    // Match the server-side canonicalization used in your Supabase function:
    // function-name-only path (/receipt-ingest)
    const urlPath = new URL(ingestUrl).pathname;
    const fnName = urlPath.split("/").filter(Boolean).pop() ?? "receipt-ingest";
    const path = `/${fnName}`;

    const canonical = `RL1\nPOST\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
    const sig = hmacB64url(RL_SECRET, canonical);

    // Debug echo is opt-in and should remain non-default.
    const debug = req.headers.get("x-rl-debug") === "1";

    const res = await fetch(ingestUrl, {
      method: "POST",
      cache: "no-store",
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

    if (!res.ok) {
      return bad(req, 502, "receipt-ingest returned non-2xx", {
        request_id,
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

    return jsonWithCors(req, 200, {
      request_id,
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
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return bad(req, 500, "Unhandled error", { request_id, message: msg });
  }
}
