import { buildSupervisorEndpointPath, closeCodes, protocolVersion } from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestControlPlane, type TestThread } from "../test-support/test-control-plane.js";
import { attemptUpgrade } from "../test-support/test-socket.js";

let controlPlane: TestControlPlane;
let thread: TestThread;

beforeEach(async () => {
  controlPlane = await TestControlPlane.start();
  thread = await controlPlane.createThread();
});

afterEach(async () => {
  await controlPlane.close();
});

function supervisorUrl(threadId = thread.threadId): string {
  return `${controlPlane.baseUrl}${buildSupervisorEndpointPath({ threadId })}`;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("the supervisor endpoint", () => {
  it("accepts a supervisor that presents its thread's token", async () => {
    const outcome = await attemptUpgrade(supervisorUrl(), bearer(thread.supervisorToken));

    expect(outcome).toEqual({ opened: true });
  });

  it("refuses a supervisor without a token with HTTP 401", async () => {
    const outcome = await attemptUpgrade(supervisorUrl(), {});

    expect(outcome).toMatchObject({ opened: false, statusCode: 401 });
  });

  it("refuses a supervisor with the wrong token with HTTP 401", async () => {
    const outcome = await attemptUpgrade(
      supervisorUrl(),
      bearer(`${thread.supervisorToken}-but-wrong`),
    );

    expect(outcome).toMatchObject({ opened: false, statusCode: 401 });
  });

  it("refuses another thread's token with HTTP 401, so one sandbox cannot pass itself off as another's", async () => {
    const otherThread = await controlPlane.createThread();

    const outcome = await attemptUpgrade(
      supervisorUrl(otherThread.threadId),
      bearer(thread.supervisorToken),
    );

    expect(outcome).toMatchObject({ opened: false, statusCode: 401 });
  });

  it("refuses a supervisor for a thread that does not exist with HTTP 401", async () => {
    const outcome = await attemptUpgrade(
      supervisorUrl("thread-that-was-never-created"),
      bearer(thread.supervisorToken),
    );

    expect(outcome).toMatchObject({ opened: false, statusCode: 401 });
  });

  it("refuses a supervisor that speaks another protocol version with HTTP 400", async () => {
    const url = supervisorUrl().replace(
      `protocolVersion=${protocolVersion}`,
      "protocolVersion=999",
    );

    const outcome = await attemptUpgrade(url, bearer(thread.supervisorToken));

    expect(outcome).toMatchObject({
      opened: false,
      statusCode: 400,
      responseBody: expect.stringContaining("Protocol version"),
    });
  });

  it("refuses an upgrade for a path that is not an endpoint with HTTP 404", async () => {
    const outcome = await attemptUpgrade(
      `${controlPlane.baseUrl}/somewhere-else`,
      bearer(thread.supervisorToken),
    );

    expect(outcome).toMatchObject({ opened: false, statusCode: 404 });
  });

  it("closes the previous supervisor of a thread when a newer one connects", async () => {
    const olderSupervisor = await controlPlane.connectSupervisor(thread);

    const newerSupervisor = await controlPlane.connectSupervisor(thread);
    const client = await controlPlane.connectClient(thread.threadId);
    client.interruptAgent();

    expect((await olderSupervisor.closed).closeCode).toBe(closeCodes.supersededByNewerSupervisor);
    expect(
      await newerSupervisor.inbox.waitFor(
        "an interrupt",
        (message) => message.type === "interrupt_agent",
      ),
    ).toEqual({ type: "interrupt_agent" });
    expect(olderSupervisor.inbox.messages.map((message) => message.type)).toEqual([
      "supervisor_welcome",
      "prepare_workspace",
      "configure_model_access",
      "desktop_control",
    ]);
  });

  it("closes a supervisor that sends an invalid message", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);

    supervisor.sendRawFrame(JSON.stringify({ type: "agent_event", event: { type: "made_up" } }));

    expect((await supervisor.closed).closeCode).toBe(closeCodes.invalidMessage);
  });

  it("closes a supervisor that sends a frame that is not JSON", async () => {
    const supervisor = await controlPlane.connectSupervisor(thread);

    supervisor.sendRawFrame("{ not json");

    expect((await supervisor.closed).closeCode).toBe(closeCodes.invalidMessage);
  });
});
