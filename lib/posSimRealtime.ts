// lib/posSimRealtime.ts
import type {
  JsonObject,
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

export function snapshotPayload(snapshot: PosSimSnapshot): JsonObject {
  // snapshot is not JsonValue-typed; cast is intentional + contained
  return { snapshot } as unknown as JsonObject;
}
