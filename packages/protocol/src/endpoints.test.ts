import { describe, expect, it } from "vitest";
import {
  buildClientEndpointPath,
  buildSupervisorEndpointPath,
  parseClientEndpointPath,
  parseSupervisorEndpointPath,
} from "./endpoints.js";
import { protocolVersion } from "./protocol-version.js";

describe("supervisor endpoint", () => {
  it.each(["thread-1", "Thread_2", "a".repeat(64)])(
    "parses back the thread identifier %j it was built with",
    (threadId) => {
      const path = buildSupervisorEndpointPath({ threadId });

      expect(parseSupervisorEndpointPath(path)).toEqual({ ok: true, value: { threadId } });
    },
  );

  it("carries the protocol version", () => {
    expect(buildSupervisorEndpointPath({ threadId: "thread-1" })).toBe(
      `/threads/thread-1/supervisor?protocolVersion=${protocolVersion}`,
    );
  });

  it("rejects a peer speaking another protocol version", () => {
    const result = parseSupervisorEndpointPath("/threads/thread-1/supervisor?protocolVersion=999");

    expect(result).toEqual({
      ok: false,
      errorMessage: expect.stringContaining('Protocol version "999" is not supported'),
    });
  });

  it("rejects a supervisor still speaking version 3, saying which version is expected", () => {
    const result = parseSupervisorEndpointPath("/threads/thread-1/supervisor?protocolVersion=3");

    expect(result).toEqual({
      ok: false,
      errorMessage: 'Protocol version "3" is not supported; expected 4.',
    });
  });

  it("rejects a peer that does not state its protocol version", () => {
    expect(parseSupervisorEndpointPath("/threads/thread-1/supervisor").ok).toBe(false);
  });

  it("rejects a thread identifier that could escape a path or a file name", () => {
    for (const unsafeThreadId of ["a%2Fb", "..", "thread%20one", "a".repeat(65)]) {
      const requestTarget = `/threads/${unsafeThreadId}/supervisor?protocolVersion=${protocolVersion}`;
      expect(parseSupervisorEndpointPath(requestTarget).ok).toBe(false);
    }
  });

  it("rejects the client endpoint", () => {
    const clientPath = buildClientEndpointPath({ threadId: "thread-1", lastSeenSequence: 0 });

    expect(parseSupervisorEndpointPath(clientPath).ok).toBe(false);
  });

  it.each([
    "/threads//supervisor?protocolVersion=1",
    "/threads/thread-1/supervisor/extra?protocolVersion=1",
    "/thread/thread-1/supervisor?protocolVersion=1",
    "/threads/%E0%A4%A/supervisor?protocolVersion=1",
    `/threads/${"x".repeat(257)}/supervisor?protocolVersion=1`,
  ])("rejects the malformed path %s", (path) => {
    expect(parseSupervisorEndpointPath(path).ok).toBe(false);
  });
});

describe("client endpoint", () => {
  it.each([
    { threadId: "thread-1", lastSeenSequence: 0 },
    { threadId: "thread-1", lastSeenSequence: 42 },
    { threadId: "Thread_2", lastSeenSequence: Number.MAX_SAFE_INTEGER },
  ])(
    "parses back the parameters it was built with: $threadId after $lastSeenSequence",
    (parameters) => {
      const path = buildClientEndpointPath(parameters);

      expect(parseClientEndpointPath(path)).toEqual({ ok: true, value: parameters });
    },
  );

  it("carries the last seen sequence and the protocol version", () => {
    expect(buildClientEndpointPath({ threadId: "thread-1", lastSeenSequence: 7 })).toBe(
      `/threads/thread-1/client?lastSeenSequence=7&protocolVersion=${protocolVersion}`,
    );
  });

  it.each(["", "-1", "1.5", "01", "1e3", "abc", "9007199254740993"])(
    "rejects the last seen sequence %j",
    (lastSeenSequence) => {
      const path = `/threads/thread-1/client?protocolVersion=${protocolVersion}&lastSeenSequence=${lastSeenSequence}`;

      expect(parseClientEndpointPath(path)).toEqual({
        ok: false,
        errorMessage: expect.stringContaining("lastSeenSequence"),
      });
    },
  );

  it("rejects a connection that does not say what it last saw", () => {
    const path = `/threads/thread-1/client?protocolVersion=${protocolVersion}`;

    expect(parseClientEndpointPath(path).ok).toBe(false);
  });

  it("rejects the supervisor endpoint", () => {
    const supervisorPath = buildSupervisorEndpointPath({ threadId: "thread-1" });

    expect(parseClientEndpointPath(supervisorPath).ok).toBe(false);
  });
});
