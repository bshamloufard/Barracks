import { identifierSchema } from "./identifier.js";
import type { ParseResult } from "./parse-result.js";
import { protocolVersion } from "./protocol-version.js";

/**
 * The URLs that supervisors and clients open WebSockets on. Who is connecting
 * and to which thread is settled once, in the upgrade request, so messages
 * never need to repeat it. Builders return a path with its query string, to
 * be resolved against the control plane's base URL; parsers accept the
 * request target of an incoming upgrade request (Node's `request.url`).
 *
 * Both URLs carry the protocol version so the control plane can refuse a peer
 * that speaks a different one before accepting the connection.
 */

export const protocolVersionQueryParameter = "protocolVersion";
export const lastSeenSequenceQueryParameter = "lastSeenSequence";

export type SupervisorEndpointParameters = { threadId: string };

/**
 * `lastSeenSequence` is the sequence of the last thread event the client
 * holds, or 0 for none. If the control plane does not hold that event, it
 * replays the whole thread instead (see `replayAnnouncementSchema`).
 */
export type ClientEndpointParameters = { threadId: string; lastSeenSequence: number };

const supervisorEndpointName = "supervisor";
const clientEndpointName = "client";

export function buildSupervisorEndpointPath(parameters: SupervisorEndpointParameters): string {
  return buildThreadEndpointPath(
    parameters.threadId,
    supervisorEndpointName,
    new URLSearchParams(),
  );
}

export function buildClientEndpointPath(parameters: ClientEndpointParameters): string {
  const query = new URLSearchParams({
    [lastSeenSequenceQueryParameter]: String(parameters.lastSeenSequence),
  });
  return buildThreadEndpointPath(parameters.threadId, clientEndpointName, query);
}

export function parseSupervisorEndpointPath(
  requestTarget: string,
): ParseResult<SupervisorEndpointParameters> {
  const endpoint = parseThreadEndpoint(requestTarget, supervisorEndpointName);
  if (!endpoint.ok) {
    return endpoint;
  }
  return { ok: true, value: { threadId: endpoint.value.threadId } };
}

export function parseClientEndpointPath(
  requestTarget: string,
): ParseResult<ClientEndpointParameters> {
  const endpoint = parseThreadEndpoint(requestTarget, clientEndpointName);
  if (!endpoint.ok) {
    return endpoint;
  }
  const lastSeenSequence = parseLastSeenSequence(
    endpoint.value.query.get(lastSeenSequenceQueryParameter),
  );
  if (!lastSeenSequence.ok) {
    return lastSeenSequence;
  }
  return {
    ok: true,
    value: { threadId: endpoint.value.threadId, lastSeenSequence: lastSeenSequence.value },
  };
}

function buildThreadEndpointPath(
  threadId: string,
  endpointName: string,
  query: URLSearchParams,
): string {
  query.set(protocolVersionQueryParameter, String(protocolVersion));
  return `/threads/${encodeURIComponent(threadId)}/${endpointName}?${query.toString()}`;
}

type ThreadEndpoint = { threadId: string; query: URLSearchParams };

function parseThreadEndpoint(
  requestTarget: string,
  endpointName: string,
): ParseResult<ThreadEndpoint> {
  // A request target is usually a path and query without a host, and URL only
  // parses complete URLs, so it is resolved against a placeholder origin.
  const url = URL.parse(requestTarget, "http://placeholder.invalid");
  if (url === null) {
    return { ok: false, errorMessage: `Request target "${requestTarget}" is not a valid URL.` };
  }
  const threadId = parseThreadId(url.pathname, endpointName);
  if (!threadId.ok) {
    return threadId;
  }
  const versionMismatch = describeProtocolVersionMismatch(
    url.searchParams.get(protocolVersionQueryParameter),
  );
  if (versionMismatch !== undefined) {
    return { ok: false, errorMessage: versionMismatch };
  }
  return { ok: true, value: { threadId: threadId.value, query: url.searchParams } };
}

function parseThreadId(pathname: string, endpointName: string): ParseResult<string> {
  const segments = pathname.split("/");
  const [leadingEmptySegment, threadsSegment, encodedThreadId, endpointSegment] = segments;
  const hasExpectedShape =
    segments.length === 4 &&
    leadingEmptySegment === "" &&
    threadsSegment === "threads" &&
    endpointSegment === endpointName &&
    encodedThreadId !== undefined;
  if (!hasExpectedShape) {
    return {
      ok: false,
      errorMessage: `Path "${pathname}" does not match /threads/{threadId}/${endpointName}.`,
    };
  }
  const threadId = decodePathSegment(encodedThreadId);
  if (!threadId.ok) {
    return threadId;
  }
  if (!identifierSchema.safeParse(threadId.value).success) {
    return { ok: false, errorMessage: `Thread identifier in path "${pathname}" is not valid.` };
  }
  return threadId;
}

function decodePathSegment(encodedSegment: string): ParseResult<string> {
  try {
    return { ok: true, value: decodeURIComponent(encodedSegment) };
  } catch {
    return {
      ok: false,
      errorMessage: `Path segment "${encodedSegment}" is not valid percent-encoding.`,
    };
  }
}

function describeProtocolVersionMismatch(versionText: string | null): string | undefined {
  if (versionText === String(protocolVersion)) {
    return undefined;
  }
  return `Protocol version "${versionText ?? ""}" is not supported; expected ${protocolVersion}.`;
}

function parseLastSeenSequence(sequenceText: string | null): ParseResult<number> {
  const lastSeenSequence = Number(sequenceText);
  const isWholeNumberWithoutDecoration =
    sequenceText !== null && /^(0|[1-9][0-9]*)$/.test(sequenceText);
  if (!isWholeNumberWithoutDecoration || !Number.isSafeInteger(lastSeenSequence)) {
    return {
      ok: false,
      errorMessage: `Query parameter ${lastSeenSequenceQueryParameter} must be 0 or a positive whole number, got "${sequenceText ?? ""}".`,
    };
  }
  return { ok: true, value: lastSeenSequence };
}
