// lib/posSimRealtime.ts
import type {
  JsonObject,
  JsonValue,
  PosSimEvent,
  PosSimEventType,
  PosSimSnapshot,
} from "./posSimTypes";

export function channelName(sessionId: string): string {
  return `pos-sim:${sessionId}`;
}

export function makeEvent(
  type: PosSimEventType,
  session_id: string,
  payload: JsonObject,
  sale_id: string | null = null
): PosSimEvent {
  return {
    type,
    session_id,
    sale_id,
    ts: new Date().toISOString(),
    payload,
  };
}

/**
 * Convert JS values into JsonValue (recursive),
 * stripping undefined (jsonb cannot store undefined).
 */
function toJson(v: unknown): JsonValue {
  if (v === null) return null;

  if (typeof v === "string") return v;

  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }

  if (typeof v === "boolean") return v;

  if (Array.isArray(v)) {
    const out: JsonValue[] = [];
    for (const item of v) {
      if (item === undefined) continue;
      out.push(toJson(item));
    }
    return out;
  }

  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const out: JsonObject = {};
    for (const [k, val] of Object.entries(obj)) {
      if (val === undefined) continue;
      out[k] = toJson(val);
    }
    return out;
  }

  // bigint, symbol, function, undefined, etc.
  try {
    return String(v);
  } catch {
    return null;
  }
}


export function snapshotPayload(snapshot: PosSimSnapshot): JsonObject {
  return { snapshot: toJson(snapshot) };
}
