// app/api/returns/validate/route.ts

import { NextResponse } from "next/server";
import crypto from "crypto";

const EDGE_FN = "returns-verify";

function b64url(buf: Buffer) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha256Hex(buf: Buffer) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function hmacB64url(secret: string, msg: string) {
  return b64url(crypto.createHmac("sha256", secret).update(msg).digest());
}

function buildRlHeaders(method: string, path: string, bodyBytes: Buffer) {
  const secret = process.env.RL_SIGNING_SECRET ?? "";
  if (!secret) throw new Error("missing_rl_signing_secret");

  const tsMs = Date.now().toString();
  const nonce = crypto.randomUUID();
  const bodyHash = sha256Hex(bodyBytes);

  const canonical = `RL1\n${method.toUpperCase()}\n${path}\n${tsMs}\n${nonce}\n${bodyHash}`;
  const sig = hmacB64url(secret, canonical);

  return {
    "x-rl-ts": tsMs,
    "x-rl-nonce": nonce,
    "x-rl-body-sha256": bodyHash,
    "x-rl-sig": sig,
  };
}

function edgeUrl(fnName: string) {
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!supaUrl) throw new Error("missing_NEXT_PUBLIC_SUPABASE_URL");
  return `${supaUrl.replace(/\/$/, "")}/functions/v1/${fnName}`;
}

export async function POST(req: Request) {
  try {
    const verifierKey = req.headers.get("x-verifier-key")?.trim() || "";
    if (!verifierKey) {
      return NextResponse.json(
        { ok: false, error: "missing_verifier_key", request_id: crypto.randomUUID() },
        { status: 401 }
      );
    }

    const bodyText = await req.text();
    const bodyBytes = Buffer.from(bodyText, "utf8");

    // IMPORTANT: edge canonicalizes to "/returns-verify" (function name only)
    const path = `/${EDGE_FN}`;
    const rl = buildRlHeaders("POST", path, bodyBytes);

    const res = await fetch(edgeUrl(EDGE_FN), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-verifier-key": verifierKey,
        ...rl,
      },
      body: bodyText,
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        ok: false,
        error: "proxy_unhandled_error",
        details: msg,
        request_id: crypto.randomUUID(),
      },
      { status: 500 }
    );
  }
}
