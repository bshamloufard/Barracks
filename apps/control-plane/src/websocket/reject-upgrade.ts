import { STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";

/**
 * Answers a WebSocket upgrade request with an ordinary HTTP error, so a peer
 * the control plane refuses never gets a WebSocket at all. The reason goes in
 * the body for whoever is debugging the peer; it never contains secrets.
 */
export function rejectUpgrade(
  socket: Duplex,
  statusCode: number,
  reason: string,
  extraHeaders: Record<string, string> = {},
): void {
  const body = `${reason}\n`;
  const headers = {
    Connection: "close",
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    ...extraHeaders,
  };
  const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  const statusLine = `HTTP/1.1 ${statusCode} ${STATUS_CODES[statusCode] ?? ""}`;
  socket.end(`${[statusLine, ...headerLines].join("\r\n")}\r\n\r\n${body}`);
}
