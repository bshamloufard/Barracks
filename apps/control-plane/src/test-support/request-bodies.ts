import type { ProviderApiFormat } from "@barrack/model-catalogue";
import { JsonBodyScanner } from "../model-proxy/json-body-scanner.js";
import { defaultModelProxyLimits } from "../model-proxy/model-proxy-limits.js";
import {
  type BodyInspection,
  inspectRequestBody,
  requestBodyShapeLimits,
} from "../model-proxy/request-body.js";

/**
 * A request body checked as the proxy checks one: scanned, as it would be
 * while it arrives (in one chunk here), then inspected; or why it was
 * refused, for a provider of no special kind unless told one.
 */
export function inspectWholeBody(
  format: ProviderApiFormat,
  body: object | string | Buffer,
  providerId = "a-provider",
): BodyInspection | { kind: "invalid"; reason: string } {
  const received = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const scanner = new JsonBodyScanner(requestBodyShapeLimits, format);
  scanner.write(received);
  const scanned = scanner.finish();
  if (scanned.kind === "invalid") {
    return scanned;
  }
  return inspectRequestBody(
    format,
    providerId,
    received,
    scanned.body,
    defaultModelProxyLimits.maximumRequestBytes,
  );
}
