import { findAgentRequestShape, type ProviderApiFormat } from "@barrack/model-catalogue";
import type { ProviderAccess } from "@barrack/protocol";
import { JsonBodyScanner, type JsonScanProblem } from "../model-proxy/json-body-scanner.js";
import { defaultModelProxyLimits } from "../model-proxy/model-proxy-limits.js";
import {
  type BodyInspection,
  inspectRequestBody,
  requestBodyShapeLimits,
} from "../model-proxy/request-body.js";

/** A relayed provider for each format, whose requests the tests send unless told another. */
const providerOfFormat: Readonly<Record<ProviderApiFormat, string>> = {
  anthropic_messages: "anthropic",
  openai_responses: "openai",
  openai_chat_completions: "groq",
};

/**
 * A request body checked as the proxy checks one: scanned against the
 * shape of the agent's requests to the provider when the proxy spends
 * `access` on them, as it would be while it arrives (in one chunk here),
 * then inspected; or why it was refused.
 */
export function inspectWholeBody(
  format: ProviderApiFormat,
  body: object | string | Buffer,
  providerId = providerOfFormat[format],
  access: ProviderAccess = "api_key",
): BodyInspection | JsonScanProblem {
  const received = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const shape = findAgentRequestShape(providerId, format, access);
  if (shape === undefined) {
    throw new Error(`The agent sends ${providerId} no request in ${format} on its ${access}.`);
  }
  const scanner = new JsonBodyScanner(requestBodyShapeLimits, format, shape);
  scanner.write(received);
  const scanned = scanner.finish();
  if (scanned.kind !== "scanned") {
    return scanned;
  }
  return inspectRequestBody(
    format,
    shape,
    received,
    scanned.body,
    defaultModelProxyLimits.maximumRequestBytes,
  );
}
