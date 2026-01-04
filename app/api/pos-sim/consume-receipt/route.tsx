// app/api/pos-sim/consume-receipt/route.ts
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

function bad(status: number, error: string, details?: unknown) {
  return NextResponse.json(
    { error, ...(details ? { details } : {}) },
    { status }
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

    const RL_SECRET = process.env.RL_SIGNING_SECRET;
    if (!RL_SECRET) return bad(500, "Missing RL_SIGNING_SECRET in Vercel env");

    const consumeUrl = `${supabaseUrl.replace(
      /\/+$/,
      ""
    )}/functions/v1/receipt-consume`;

    const bodyUnknown: unknown = await req.json().catch(() => null);
    if (!bodyUnknown || typeof bodyUnknown !== "object") {
      return bad(400, "Invalid JSON body");
    }

    const b = bodyUnknown as Record<string, unknown>;

    const retailer_id = asNonEmptyString(b.retailer_id);
    const store_id = asNonEmptyString(b.store_id);
    const terminal_code = asNonEmptyString(b.terminal_code);
    const token_id = asNonEmptyString(b.token_id);
    const reason = asNonEmptyString(b.reason) ?? null;

    if (!store_id || !terminal_code || !token_id) {
      return bad(400, "Missing store_id / terminal_code / token_id");
    }

    const cleaned: Body = {
      store_id,
      terminal_code,
      token_id,
      reason,
      ...(retailer_id ? { retailer_id } : {}),
    };

    // IMPORTANT: hash/sign the EXACT JSON you send
    const rawBody = JSON.stringify(cleaned);

    // RL-030 headers
    const ts = Date.now().toString();
    const nonce = nonceB64url();
    const bodyHash = sha256HexUtf8(rawBody);

    // MUST match the edge pathname exactly
    const path = new URL(consumeUrl).pathname;
    const canonical = `RL1\nPOST\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
    const sig = hmacB64url(RL_SECRET, canonical);

    const res = await fetch(consumeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,

        // terminal verifier auth
        "x-verifier-key": terminalKey,

        // RL-030 signature headers
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
      return bad(502, "receipt-consume returned non-2xx", parsed);
    }

    return NextResponse.json(parsed, { status: 200 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return bad(500, "Unhandled error", msg);
  }
}
