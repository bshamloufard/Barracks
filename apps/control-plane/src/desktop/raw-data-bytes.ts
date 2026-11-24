import type { RawData } from "ws";

/** A WebSocket frame's bytes as one buffer, however `ws` delivered them. */
export function rawDataBytes(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return data instanceof ArrayBuffer ? Buffer.from(data) : data;
}
