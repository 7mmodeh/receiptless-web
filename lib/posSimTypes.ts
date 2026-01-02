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

  fallback: {
    printed: boolean;
    print_reason: null | "NETWORK" | "ISSUANCE_FAIL" | "CUSTOMER_REQUEST";
  };
};

export type PosSimEventType =
  | "SESSION_CREATED"
  | "CUSTOMER_JOINED"
  | "SNAPSHOT_SYNC"
  | "CART_UPDATED"
  | "RESET_REQUESTED";

/**
 * JSON payload type used for events.
 * Non-recursive on purpose to avoid TS(2456) in some TS configs.
 * Still prevents `any` and is sufficient for our simulator payloads.
 */
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
