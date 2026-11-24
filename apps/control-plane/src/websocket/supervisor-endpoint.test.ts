import { buildSupervisorEndpointPath, closeCodes } from "@barrack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestControlPlane, testSupervisorToken } from "../test-support/test-control-plane.js";
import { attemptUpgrade } from "../test-support/test-socket.js";

const threadId = "thread-1";

let controlPlane: TestControlPlane;

beforeEach(async () => {
  controlPlane = await TestControlPlane.start();
});

afterEach(async () => {
  await controlPlane.close();
});

function supervisorUrl(): string {
  return `${controlPlane.baseUrl}${buildSupervisorEndpointPath({ threadId })}`;
}

describe("the supervisor endpoint", () => {
  it("accepts a supervisor that presents the token", async () => {
    const outcome = await attemptUpgrade(supervisorUrl(), {
      Authorization: `Bearer ${testSupervisorToken}`,
    });

    expect(outcome).toEqual({ opened: true });
  });

  it("refuses a supervisor without a token with HTTP 401", async () => {
    const outcome = await attemptUpgrade(supervisorUrl(), {});

    expect(outcome).toMatchObject({ opened: false, statusCode: 401 });
  });

  it("refuses a supervisor with the wrong token with HTTP 401", async () => {
    const outcome = await attemptUpgrade(supervisorUrl(), {
      Authorization: `Bearer ${testSupervisorToken}-but-wrong`,
    });

    expect(outcome).toMatchObject({ opened: false, statusCode: 401 });
  });

  it("refuses a supervisor that speaks another protocol version with HTTP 400", async () => {
    const url = supervisorUrl().replace("protocolVersion=1", "protocolVersion=999");

    const outcome = await attemptUpgrade(url, { Authorization: `Bearer ${testSupervisorToken}` });

    expect(outcome).toMatchObject({
      opened: false,
      statusCode: 400,
      responseBody: expect.stringContaining("Protocol version"),
    });
  });

  it("refuses an upgrade for a path that is not an endpoint with HTTP 404", async () => {
    const outcome = await attemptUpgrade(`${controlPlane.baseUrl}/somewhere-else`, {
      Authorization: `Bearer ${testSupervisorToken}`,
    });

    expect(outcome).toMatchObject({ opened: false, statusCode: 404 });
  });

  it("closes the previous supervisor of a thread when a newer one connects", async () => {
    const olderSupervisor = await controlPlane.connectSupervisor(threadId);

    const newerSupervisor = await controlPlane.connectSupervisor(threadId);
    const client = await controlPlane.connectClient(threadId);
    client.interruptAgent();

    expect((await olderSupervisor.closed).closeCode).toBe(closeCodes.supersededByNewerSupervisor);
    expect(
      await newerSupervisor.inbox.waitFor(
        "an interrupt",
        (message) => message.type === "interrupt_agent",
      ),
    ).toEqual({ type: "interrupt_agent" });
    expect(olderSupervisor.inbox.messages).toEqual([]);
  });

  it("closes a supervisor that sends an invalid message", async () => {
    const supervisor = await controlPlane.connectSupervisor(threadId);

    supervisor.sendRawFrame(JSON.stringify({ type: "agent_event", event: { type: "made_up" } }));

    expect((await supervisor.closed).closeCode).toBe(closeCodes.invalidMessage);
  });

  it("closes a supervisor that sends a frame that is not JSON", async () => {
    const supervisor = await controlPlane.connectSupervisor(threadId);

    supervisor.sendRawFrame("{ not json");

    expect((await supervisor.closed).closeCode).toBe(closeCodes.invalidMessage);
  });
});
