import { threadIdSchema } from "./identifier.js";
import { modelProviderIdSchema } from "./model-access.js";
import type { ParseResult } from "./parse-result.js";

/**
 * Where a thread's agent sends a provider's requests when the control plane
 * relays that provider's traffic: `/threads/{threadId}/model-proxy/{providerId}`
 * is the base URL the agent is given in place of the provider's, and the
 * agent's own client adds the provider's API path to it (`/v1/messages`,
 * say). The agent's client builds these URLs, not Barrack, so they carry no
 * protocol version.
 *
 * Everything in such a request comes from the sandbox and is untrusted, so
 * the parser accepts only plain path segments: no percent-encoding, no empty,
 * `.` or `..` segments, nothing a server might read differently from this.
 */

/** The path segment, after the thread, that names the model proxy. */
export const modelProxyEndpointName = "model-proxy";

const plainSegmentPattern = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;

/** Longer than any provider API path, short enough to refuse at a glance. */
const maximumRequestTargetLength = 2048;

export type ModelProxyRequestTarget = {
  threadId: string;
  providerId: string;
  /** The provider API path the agent asked for, starting with `/`, such as `/v1/messages`. */
  apiPath: string;
  /** The query string without its `?`, or empty. */
  query: string;
};

export function buildModelProxyBasePath(threadId: string, providerId: string): string {
  return `/threads/${threadId}/${modelProxyEndpointName}/${providerId}`;
}

/** Whether a request is meant for the model proxy at all, before it is parsed. */
export function isModelProxyRequestTarget(requestTarget: string): boolean {
  const segments = requestTarget.split("?", 1)[0]?.split("/") ?? [];
  return segments[1] === "threads" && segments[3] === modelProxyEndpointName;
}

export function parseModelProxyRequestTarget(
  requestTarget: string,
): ParseResult<ModelProxyRequestTarget> {
  if (requestTarget.length > maximumRequestTargetLength) {
    return { ok: false, errorMessage: "The request target is too long." };
  }
  const queryStart = requestTarget.indexOf("?");
  const path = queryStart === -1 ? requestTarget : requestTarget.slice(0, queryStart);
  const query = queryStart === -1 ? "" : requestTarget.slice(queryStart + 1);
  const [leadingEmpty, threadsSegment, threadId, endpointSegment, providerId, ...apiSegments] =
    path.split("/");
  const isShapedAsExpected =
    leadingEmpty === "" &&
    threadsSegment === "threads" &&
    endpointSegment === modelProxyEndpointName &&
    threadId !== undefined &&
    threadIdSchema.safeParse(threadId).success &&
    providerId !== undefined &&
    modelProviderIdSchema.safeParse(providerId).success &&
    apiSegments.length > 0 &&
    apiSegments.every((segment) => plainSegmentPattern.test(segment));
  if (!isShapedAsExpected) {
    return {
      ok: false,
      errorMessage: `Path does not match /threads/{threadId}/${modelProxyEndpointName}/{providerId}/{api path}.`,
    };
  }
  return {
    ok: true,
    value: { threadId, providerId, apiPath: `/${apiSegments.join("/")}`, query },
  };
}
