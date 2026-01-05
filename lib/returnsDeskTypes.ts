// lib/returnsDeskTypes.ts

export type ReturnsVerifyOk = {
  ok: true;
  token: {
    token_id: string;
    status: string | null;
    receipt_id: string;
    consumed_at: string | null;
  };
  receipt: {
    id: string;
    retailer_id: string;
    store_id: string;
    terminal_id: string | null;
    issued_at: string;
    currency: string;
    subtotal: number;
    vat_total: number;
    total: number;
    status: string | null;
    consumed_at: string | null;
  };
  items: Array<{
    line_no: number;
    sku: string | null;
    name: string;
    qty: number;
    unit_price: number;
    line_total: number;
    vat_rate: number | null;
    vat_amount: number | null;
  }>;
  request_id: string;
};

export type ReturnsVerifyErr = {
  ok: false;
  error: string;
  details?: unknown;
  request_id: string;
};

export type ReturnsVerifyResponse = ReturnsVerifyOk | ReturnsVerifyErr;

export type ReceiptConsumeOk = {
  ok: true;
  already_consumed: boolean;
  token_id: string;
  receipt_id: string;
  consumed_at: string | null;
  request_id: string;
};

export type ReceiptConsumeErr = {
  ok: false;
  error: string;
  details?: unknown;
  request_id: string;
};

export type ReceiptConsumeResponse = ReceiptConsumeOk | ReceiptConsumeErr;

// UI states (RL-071)
export type ReturnDeskStatus =
  | "IDLE"
  | "LOOKUP_LOADING"
  | "ELIGIBLE"
  | "CONSUMED"
  | "INVALID"
  | "NETWORK_ERROR"
  | "CONSUME_LOADING";

export type ReturnDeskViewModel =
  | { kind: "IDLE" }
  | { kind: "LOOKUP_LOADING" }
  | { kind: "CONSUME_LOADING"; receiptId: string }
  | { kind: "INVALID"; reason: string; requestId?: string }
  | { kind: "NETWORK_ERROR"; message: string }
  | {
      kind: "ELIGIBLE" | "CONSUMED";
      requestId: string;
      receipt: ReturnsVerifyOk["receipt"];
      token: ReturnsVerifyOk["token"];
      items: ReturnsVerifyOk["items"];
    };
