// lib/returnsDeskClient.ts

import type {
  ReturnsVerifyResponse,
  ReceiptConsumeResponse,
} from "./returnsDeskTypes";

async function fetchJson<T>(
  url: string,
  opts: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 5000, ...init } = opts;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const data = (await res.json()) as T;
    return data;
  } finally {
    clearTimeout(t);
  }
}

export async function returnsValidate(params: {
  token_id: string;
  store_id: string;
  terminal_code: string;
  verifier_key: string;
}): Promise<ReturnsVerifyResponse> {
  const { token_id, store_id, terminal_code, verifier_key } = params;

  return fetchJson<ReturnsVerifyResponse>("/api/returns/validate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-verifier-key": verifier_key,
    },
    body: JSON.stringify({ token_id, store_id, terminal_code }),
    timeoutMs: 5000,
  });
}

export async function returnsConsume(params: {
  token_id: string;
  store_id: string;
  terminal_code: string;
  verifier_key: string;
  reason?: string;
}): Promise<ReceiptConsumeResponse> {
  const { token_id, store_id, terminal_code, verifier_key, reason } = params;

  return fetchJson<ReceiptConsumeResponse>("/api/returns/consume", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-verifier-key": verifier_key,
    },
    body: JSON.stringify({
      token_id,
      store_id,
      terminal_code,
      reason: reason ?? "return_refund",
    }),
    timeoutMs: 8000,
  });
}
