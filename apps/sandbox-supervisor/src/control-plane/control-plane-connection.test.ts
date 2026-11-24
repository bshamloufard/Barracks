import {
  buildSupervisorEndpointPath,
  type ControlPlaneToSupervisorMessage,
  closeCodes,
  type SupervisorToControlPlaneMessage,
} from "@barrack/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createSilentLogger } from "../test-support/silent-logger.js";
import {
  startTestControlPlane,
  type TestControlPlane,
} from "../test-support/test-control-plane.js";
import { pause, waitUntil } from "../test-support/wait-until.js";
import { type ConnectionTiming, ControlPlaneConnection } from "./control-plane-connection.js";

const fastTiming: Partial<ConnectionTiming> = {
  initialDelayInMilliseconds: 20,
  maximumDelayInMilliseconds: 40,
  heartbeatIntervalInMilliseconds: 1_000,
  heartbeatTimeoutInMilliseconds: 5_000,
};

let controlPlane: TestControlPlane;
let connection: ControlPlaneConnection;
let receivedMessages: ControlPlaneToSupervisorMessage[];
let fatalErrors: Error[];

async function connect(
  options: { answersPings?: boolean; refuseWith?: number; timing?: Partial<ConnectionTiming> } = {},
): Promise<void> {
  controlPlane = await startTestControlPlane({ answersPings: options.answersPings ?? true });
  controlPlane.refuseUpgradesWith(options.refuseWith);
  receivedMessages = [];
  fatalErrors = [];
  connection = new ControlPlaneConnection({
    controlPlaneUrl: controlPlane.url,
    threadId: "thread-1",
    supervisorToken: "token-1",
    logger: createSilentLogger(),
    onMessage: (message) => receivedMessages.push(message),
    onFatalError: (error) => fatalErrors.push(error),
    timing: { ...fastTiming, ...options.timing },
  });
  connection.open();
}

afterEach(async () => {
  await connection.close();
  await controlPlane.close();
});

function agentEvent(wasInterrupted: boolean): SupervisorToControlPlaneMessage {
  return { type: "agent_event", event: { type: "agent_run_settled", wasInterrupted } };
}

const runStarted: SupervisorToControlPlaneMessage = {
  type: "agent_event",
  event: { type: "agent_run_started" },
};

const textFragment: SupervisorToControlPlaneMessage = {
  type: "stream_fragment",
  fragment: {
    type: "assistant_text_fragment",
    messageId: "message-1",
    contentBlockIndex: 0,
    contentBlockType: "text",
    appendedText: "Hello",
  },
};

function receivedMessagesOnServer(): unknown[] {
  return controlPlane.receivedFrames.map((frame) => JSON.parse(frame));
}

describe("ControlPlaneConnection", () => {
  it("connects to the thread's supervisor endpoint with its token as a bearer credential", async () => {
    await connect();
    await waitUntil(() => controlPlane.connections.length === 1, "the supervisor connects");

    expect(controlPlane.upgradeRequests).toEqual([
      {
        path: buildSupervisorEndpointPath({ threadId: "thread-1" }),
        authorization: "Bearer token-1",
      },
    ]);
  });

  it("sends agent events and stream fragments while connected", async () => {
    await connect();
    await waitUntil(() => controlPlane.connections.length === 1, "the supervisor connects");

    connection.send(runStarted);
    connection.send(textFragment);
    await waitUntil(() => controlPlane.receivedFrames.length === 2, "both frames arrive");

    expect(receivedMessagesOnServer()).toEqual([runStarted, textFragment]);
  });

  it("keeps agent events produced during an outage and sends them in order once reconnected", async () => {
    await connect({ refuseWith: 503 });
    await waitUntil(() => controlPlane.upgradeRequests.length >= 2, "the supervisor retries");

    connection.send(runStarted);
    connection.send(agentEvent(false));
    connection.send(agentEvent(true));
    controlPlane.refuseUpgradesWith(undefined);
    await waitUntil(() => controlPlane.receivedFrames.length === 3, "the backlog arrives");

    expect(receivedMessagesOnServer()).toEqual([runStarted, agentEvent(false), agentEvent(true)]);
    expect(fatalErrors).toEqual([]);
  });

  it("drops stream fragments produced during an outage", async () => {
    await connect({ refuseWith: 503 });

    connection.send(textFragment);
    connection.send(runStarted);
    controlPlane.refuseUpgradesWith(undefined);
    await waitUntil(() => controlPlane.receivedFrames.length === 1, "the agent event arrives");
    await pause(50);

    expect(receivedMessagesOnServer()).toEqual([runStarted]);
  });

  it("reconnects after the control plane drops the connection", async () => {
    await connect();
    await waitUntil(() => controlPlane.connections.length === 1, "the supervisor connects");

    controlPlane.connections[0]?.terminate();
    await waitUntil(() => controlPlane.connections.length === 2, "the supervisor reconnects");

    expect(fatalErrors).toEqual([]);
  });

  it("stops for good, without reconnecting, when a newer supervisor supersedes it", async () => {
    await connect();
    await waitUntil(() => controlPlane.connections.length === 1, "the supervisor connects");

    controlPlane.connections[0]?.close(closeCodes.supersededByNewerSupervisor, "superseded");
    await waitUntil(() => fatalErrors.length === 1, "the connection fails for good");
    await pause(150);

    expect(controlPlane.upgradeRequests).toHaveLength(1);
    expect(fatalErrors[0]?.message).toMatch(/newer supervisor/);
  });

  // 400 is how the control plane refuses a protocol version it does not speak.
  it.each([400, 401, 403, 404, 410])(
    "stops for good, without reconnecting, when the control plane answers %i",
    async (statusCode) => {
      await connect({ refuseWith: statusCode });

      await waitUntil(() => fatalErrors.length === 1, "the connection fails for good");
      await pause(150);

      expect(controlPlane.upgradeRequests).toHaveLength(1);
      expect(fatalErrors[0]?.message).toContain(`HTTP ${statusCode}`);
    },
  );

  it.each([408, 429, 500, 502, 503])(
    "keeps retrying while the control plane answers %i",
    async (statusCode) => {
      await connect({ refuseWith: statusCode });

      await waitUntil(() => controlPlane.upgradeRequests.length >= 3, "the supervisor retries");

      expect(fatalErrors).toEqual([]);
    },
  );

  it("keeps retrying while nothing is listening at the control plane's address", async () => {
    await connect();
    await waitUntil(() => controlPlane.connections.length === 1, "the supervisor connects");
    await controlPlane.close();

    await pause(200);

    expect(fatalErrors).toEqual([]);
  });

  it("passes valid messages from the control plane on and ignores invalid ones", async () => {
    await connect();
    await waitUntil(() => controlPlane.connections.length === 1, "the supervisor connects");

    controlPlane.connections[0]?.send("not json");
    controlPlane.connections[0]?.send(JSON.stringify({ type: "deliver_user_message", text: "" }));
    controlPlane.connections[0]?.send(JSON.stringify({ type: "interrupt_agent" }));
    await waitUntil(() => receivedMessages.length === 1, "the valid message arrives");
    await pause(20);

    expect(receivedMessages).toEqual([{ type: "interrupt_agent" }]);
  });

  it("drops a connection whose control plane stops answering pings, then reconnects", async () => {
    await connect({
      answersPings: false,
      timing: { heartbeatIntervalInMilliseconds: 20, heartbeatTimeoutInMilliseconds: 60 },
    });

    await waitUntil(() => controlPlane.connections.length >= 2, "the supervisor reconnects");

    expect(fatalErrors).toEqual([]);
  });

  it("fails loudly instead of dropping agent events when an outage outlasts the backlog", async () => {
    await connect({ refuseWith: 503, timing: { backlogMaximumLength: 200 } });

    for (let eventNumber = 0; eventNumber < 10; eventNumber += 1) {
      connection.send(runStarted);
    }

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]?.message).toMatch(/unreachable for too long/);
  });
});
