// app/api/pos-sim/consume-receipt/route.tsx

import { NextResponse } from "next/server";
import crypto from "crypto";

type Body = {
  retailer_id?: string | null; // OPTIONAL (edge derives it from store)
  store_id: string;
  terminal_code: string;
  token_id: string;
  reason?: string | null;
};

function isOn(v: string | undefined) {
  const s = (v ?? "").toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : { value: v };
}

function noStoreHeaders() {
  return {
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
  };
}

function bad(
  status: number,
  error: string,
  request_id: string,
  details?: unknown
) {
  return NextResponse.json(
    {
      ok: false,
      error,
      request_id,
      ...(details ? { details: asObject(details) } : {}),
    },
    { status, headers: noStoreHeaders() }
  );
}

function ok(status: number, body: unknown, request_id: string) {
  return NextResponse.json(
    { ok: true, request_id, ...asObject(body) },
    { status, headers: noStoreHeaders() }
  );
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

function canonicalFnPathFromUrl(fullUrl: string, fallbackFnName: string) {
  const urlPath = new URL(fullUrl).pathname;
  const fnName = urlPath.split("/").filter(Boolean).pop() ?? fallbackFnName;
  return `/${fnName}`;
}

export async function OPTIONS() {
  // POS sim routes are intended for server-to-server use.
  // Still respond cleanly to preflight if someone hits it from a browser.
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...noStoreHeaders(),
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    },
  });
}

export async function POST(req: Request) {
  const request_id = crypto.randomUUID();

  try {
    const enabled =
      isOn(process.env.POS_SIM_ENABLED) ||
      isOn(process.env.NEXT_PUBLIC_POS_SIM_ENABLED);
    if (!enabled) return bad(404, "pos_sim_not_enabled", request_id);

    const supabaseBase =
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey =
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
      process.env.SUPABASE_ANON_KEY;

    if (!supabaseBase)
      return bad(
        500,
        "missing_supabase_url",
        request_id,
        "Missing SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL"
      );
    if (!anonKey)
      return bad(
        500,
        "missing_anon_key",
        request_id,
        "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY"
      );

    const terminalKey = process.env.TERMINAL_KEY_TEST_001;
    if (!terminalKey)
      return bad(
        500,
        "missing_terminal_key_test_001",
        request_id,
        "Missing TERMINAL_KEY_TEST_001 in env"
      );

    const RL_SECRET = process.env.RL_SIGNING_SECRET;
    if (!RL_SECRET)
      return bad(
        500,
        "missing_rl_signing_secret",
        request_id,
        "Missing RL_SIGNING_SECRET in env"
      );

    const consumeUrl = buildSupabaseFunctionUrl(
      supabaseBase,
      "receipt-consume"
    );

    const bodyUnknown: unknown = await req.json().catch(() => null);
    if (!bodyUnknown || typeof bodyUnknown !== "object") {
      return bad(400, "invalid_json_body", request_id);
    }

    const b = bodyUnknown as Record<string, unknown>;

    const retailer_id = asNonEmptyString(b.retailer_id);
    const store_id = asNonEmptyString(b.store_id);
    const terminal_code = asNonEmptyString(b.terminal_code);
    const token_id = asNonEmptyString(b.token_id);
    const reason = asNonEmptyString(b.reason) ?? null;

    if (!store_id || !terminal_code || !token_id) {
      return bad(
        400,
        "missing_fields",
        request_id,
        "Missing store_id / terminal_code / token_id"
      );
    }

    const cleaned: Body = {
      store_id,
      terminal_code,
      token_id,
      reason,
      ...(retailer_id ? { retailer_id } : {}),
    };

    /* ==========================
       RL-030 canonical signing
    ========================== */
    const rawBody = JSON.stringify(cleaned);
    const ts = Date.now().toString();
    const nonce = nonceB64url();
    const bodyHash = sha256HexUtf8(rawBody);

    // Canonicalize to function-name-only (robust across internal routing)
    const path = canonicalFnPathFromUrl(consumeUrl, "receipt-consume");

    const canonical = `RL1\nPOST\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
    const sig = hmacB64url(RL_SECRET, canonical);

    if (isOn(process.env.RL_DEBUG)) {
      console.log(
        JSON.stringify({
          request_id,
          fn: "pos-sim/consume-receipt",
          consumeUrl,
          path,
          ts,
          nonce,
          bodyHash,
        })
      );
    }

    const res = await fetch(consumeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,

        "x-verifier-key": terminalKey,

        "x-rl-ts": ts,
        "x-rl-nonce": nonce,
        "x-rl-body-sha256": bodyHash,
        "x-rl-sig": sig,
      },
      body: rawBody,
    });

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      return bad(502, "receipt_consume_non_2xx", request_id, parsed);
    }

    return ok(200, parsed, request_id);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return bad(500, "unhandled_error", request_id, msg);
  }
}
