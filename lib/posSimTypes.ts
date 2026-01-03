// lib/posSimTypes.ts
export type PosSimMode = "web_pos" | "android_pos";

export type PaymentState =
  | "IDLE"
  | "INITIATED"
  | "PROCESSING"
  | "APPROVED"
  | "DECLINED"
  | "TIMEOUT"
  | "NETWORK_ERROR";

export type IssuanceState =
  | "IDLE"
  | "INGESTING"
  | "TOKEN_READY"
  | "FAILED"
  | "FALLBACK_PRINTED";

export type FlowStage = "BOOT" | "CART" | "CHECKOUT" | "PROCESSING" | "RESULT";

export type PosSimToggles = {
  payment_outcome: "success" | "fail" | "timeout";
  network_mode: "normal" | "slow" | "down";
  issuance_mode: "normal" | "fail" | "delay";
  print_fallback: "enabled" | "disabled";
  customer_scan_sim: "none" | "auto_success" | "auto_fail";
};

export type PosSimTerminalInfo = {
  retailer_id: string;
  store_id: string;
  terminal_code: string;
};

export type CartItem = {
  line_no: number;
  sku?: string | null;
  name: string;
  qty: number;
  unit_price: number;
  line_total: number;
  vat_rate?: number | null;
  vat_amount?: number | null;
};

export type ReceiptInfo = {
  token_id: string;
  public_url: string;
  qr_url: string;
  preview_url?: string | null;
};

export type ScanState = "NONE" | "PENDING" | "SUCCESS" | "FAIL";

export type PosSimSnapshot = {
  session_id: string | null;
  session_code: string;
  mode: PosSimMode;
  created_at: string;

  terminal: PosSimTerminalInfo;
  toggles: PosSimToggles;

  active_sale_id: string | null;

  cart: {
    currency: string;
    items: CartItem[];
    subtotal: number;
    vat_total: number;
    total: number;
  };

  flow: {
    stage: FlowStage;
    payment_state: PaymentState;
    issuance_state: IssuanceState;
  };

  receipt: ReceiptInfo | null;

  scan?: {
    state: ScanState;
    scanned_at?: string | null;
    message?: string | null;
  };

  fallback: {
    printed: boolean;
    print_reason: null | "NETWORK" | "ISSUANCE_FAIL" | "CUSTOMER_REQUEST" | "SCAN_FAIL";
  };
};

export type PosSimEventType =
  | "SESSION_CREATED"
  | "CUSTOMER_JOINED"
  | "CUSTOMER_SCANNED"
  | "CART_UPDATED"
  | "SNAPSHOT_SYNC"
  | "RESET_REQUESTED";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValueLeaf }
  | JsonValueLeaf[];

type JsonValueLeaf = string | number | boolean | null;

export type JsonObject = Record<string, JsonValue>;

export type PosSimEvent = {
  type: PosSimEventType;
  session_id: string;
  sale_id?: string | null;
  ts: string;
  payload: JsonObject;
};

// Broadcast wrapper Supabase gives to the callback
export type BroadcastMessage = {
  event: string;
  payload: unknown;
};

// --- DB event row for durable timeline ---
export type PosSimDbEvent = {
  id: string;
  session_id: string;
  event_type: string;
  payload: JsonObject;
  created_at: string;
};

// --- Receipt issuance request body (matches /api/pos-sim/issue-receipt exactly) ---
export type IssueReceiptBody = {
  retailer_id: string;
  store_id: string;
  terminal_code: string;

  issued_at: string; // ISO
  receipt_number?: string | null;

  currency: string;
  subtotal: number;
  vat_total: number;
  total: number;

  items: CartItem[];
};

export type IssueReceiptResponse = unknown;
