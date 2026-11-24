import {
  type AgentEvent,
  buildSupervisorEndpointPath,
  closeCodes,
  type StreamFragment,
} from "@barrack/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createSilentLogger } from "../test-support/silent-logger.js";
import {
  startTestControlPlane,
  type TestControlPlane,
  type TestControlPlaneOptions,
} from "../test-support/test-control-plane.js";
import { pause, waitUntil } from "../test-support/wait-until.js";
import {
  type AgentRequest,
  type ConnectionTiming,
  ControlPlaneConnection,
} from "./control-plane-connection.js";

const fastTiming: Partial<ConnectionTiming> = {
  initialDelayInMilliseconds: 20,
  maximumDelayInMilliseconds: 40,
  heartbeatIntervalInMilliseconds: 1_000,
  heartbeatTimeoutInMilliseconds: 5_000,
  closingConfirmationTimeoutInMilliseconds: 200,
};

const supervisorInstanceId = "supervisor-instance-1";

let controlPlane: TestControlPlane;
let connection: ControlPlaneConnection;
let agentRequests: AgentRequest[];
let fatalErrors: Error[];
let userMessagesDeliveredThrough: number;

async function connect(
  options: Partial<TestControlPlaneOptions> & {
    refuseWith?: number;
    timing?: Partial<ConnectionTiming>;
  } = {},
): Promise<void> {
  controlPlane = await startTestControlPlane(options);
  controlPlane.refuseUpgradesWith(options.refuseWith);
  agentRequests = [];
  fatalErrors = [];
  userMessagesDeliveredThrough = 0;
  connection = new ControlPlaneConnection({
    controlPlaneUrl: controlPlane.url,
    threadId: "thread-1",
    supervisorToken: "token-1",
    supervisorInstanceId,
    readUserMessagesDeliveredThrough: () => userMessagesDeliveredThrough,
    logger: createSilentLogger(),
    onAgentRequest: (request) => agentRequests.push(request),
    onWorkspaceMessage: () => undefined,
    onFatalError: (error) => fatalErrors.push(error),
    timing: { ...fastTiming, ...options.timing },
  });
  connection.open();
}

afterEach(async () => {
  await connection.close();
  await controlPlane.close();
});

const runStarted: AgentEvent = { type: "agent_run_started" };

function runSettled(wasInterrupted: boolean): AgentEvent {
  return { type: "agent_run_settled", wasInterrupted };
}

const textFragment: StreamFragment = {
  type: "assistant_text_fragment",
  messageId: "message-1",
  contentBlockIndex: 0,
  contentBlockType: "text",
  appendedText: "Hello",
};

function receivedMessagesOnServer(): unknown[] {
  return controlPlane.receivedFrames.map((frame) => JSON.parse(frame));
}

function agentEventFrame(eventNumber: number, event: AgentEvent) {
  return { type: "agent_event", eventNumber, event };
}

function waitUntilWelcomed(connectionCount = 1): Promise<void> {
  return waitUntil(
    () => controlPlane.hellos.length >= connectionCount,
    `connection ${connectionCount} says hello`,
  );
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

  it("opens every connection with a hello naming its instance and how far user messages were delivered", async () => {
    await connect();
    userMessagesDeliveredThrough = 7;
    await waitUntilWelcomed();

    controlPlane.connections[0]?.terminate();
    await waitUntilWelcomed(2);

    expect(controlPlane.hellos).toEqual([
      {
        type: "supervisor_hello",
        supervisorInstanceId,
        userMessagesDeliveredThroughSequence: 7,
      },
      {
        type: "supervisor_hello",
        supervisorInstanceId,
        userMessagesDeliveredThroughSequence: 7,
      },
    ]);
  });

  it("numbers agent events from 1 and sends them and stream fragments once welcomed", async () => {
    await connect();
    await waitUntilWelcomed();
    await pause(20);

    connection.sendAgentEvent(runStarted);
    connection.sendStreamFragment(textFragment);
    connection.sendAgentEvent(runSettled(false));
    await waitUntil(() => controlPlane.receivedFrames.length === 3, "every frame arrives");

    expect(receivedMessagesOnServer()).toEqual([
      agentEventFrame(1, runStarted),
      { type: "stream_fragment", fragment: textFragment },
      agentEventFrame(2, runSettled(false)),
    ]);
  });

  it("keeps agent events produced during an outage and sends them in order once welcomed", async () => {
    await connect({ refuseWith: 503 });
    await waitUntil(() => controlPlane.upgradeRequests.length >= 2, "the supervisor retries");

    connection.sendAgentEvent(runStarted);
    connection.sendAgentEvent(runSettled(false));
    connection.sendAgentEvent(runSettled(true));
    controlPlane.refuseUpgradesWith(undefined);
    await waitUntil(() => controlPlane.receivedFrames.length === 3, "the waiting events arrive");

    expect(receivedMessagesOnServer()).toEqual([
      agentEventFrame(1, runStarted),
      agentEventFrame(2, runSettled(false)),
      agentEventFrame(3, runSettled(true)),
    ]);
    expect(fatalErrors).toEqual([]);
  });

  it("drops stream fragments produced while it is not welcomed", async () => {
    await connect({ refuseWith: 503 });

    connection.sendStreamFragment(textFragment);
    connection.sendAgentEvent(runStarted);
    controlPlane.refuseUpgradesWith(undefined);
    await waitUntil(() => controlPlane.receivedFrames.length === 1, "the agent event arrives");
    await pause(50);

    expect(receivedMessagesOnServer()).toEqual([agentEventFrame(1, runStarted)]);
  });

  it("sends events the control plane never confirmed again after reconnecting, skipping those its welcome says it recorded", async () => {
    await connect({ confirmsEvents: false });
    await waitUntilWelcomed();
    connection.sendAgentEvent(runStarted);
    connection.sendAgentEvent(runSettled(false));
    connection.sendAgentEvent(runStarted);
    await waitUntil(() => controlPlane.receivedFrames.length === 3, "the events arrive");

    controlPlane.welcomeWithLastRecordedEventNumber(1);
    controlPlane.connections[0]?.terminate();
    await waitUntil(() => controlPlane.receivedFrames.length === 5, "the unconfirmed are resent");

    expect(receivedMessagesOnServer().slice(3)).toEqual([
      agentEventFrame(2, runSettled(false)),
      agentEventFrame(3, runStarted),
    ]);
  });

  it("forgets events once they are confirmed, and sends none of them again", async () => {
    await connect({ confirmsEvents: true });
    await waitUntilWelcomed();
    connection.sendAgentEvent(runStarted);
    connection.sendAgentEvent(runSettled(false));
    await waitUntil(() => controlPlane.receivedFrames.length === 2, "the events arrive");
    await pause(20);

    controlPlane.welcomeWithLastRecordedEventNumber(2);
    controlPlane.connections[0]?.terminate();
    await waitUntilWelcomed(2);
    connection.sendAgentEvent(runStarted);
    await waitUntil(() => controlPlane.receivedFrames.length === 3, "the new event arrives");

    expect(receivedMessagesOnServer()[2]).toEqual(agentEventFrame(3, runStarted));
  });

  it("fails for good when a welcome says fewer events were recorded than were confirmed", async () => {
    await connect({ confirmsEvents: true });
    await waitUntilWelcomed();
    connection.sendAgentEvent(runStarted);
    connection.sendAgentEvent(runSettled(false));
    await waitUntil(() => controlPlane.receivedFrames.length === 2, "the events arrive");
    await pause(20);

    controlPlane.welcomeWithLastRecordedEventNumber(0);
    controlPlane.connections[0]?.terminate();
    await waitUntil(() => fatalErrors.length === 1, "the connection fails for good");

    expect(fatalErrors[0]?.message).toMatch(/history no longer matches what it confirmed/);
  });

  it("waits, when closing, for the control plane to confirm what it was last sent", async () => {
    await connect({ confirmsEvents: false });
    await waitUntilWelcomed();
    connection.sendAgentEvent(runSettled(true));
    await waitUntil(() => controlPlane.receivedFrames.length === 1, "the event arrives");

    const closing = connection.close();
    await pause(50);
    const closedBeforeConfirmation = controlPlane.connections[0]?.readyState !== 1;
    controlPlane.send({ type: "agent_events_recorded", throughEventNumber: 1 });
    await closing;

    expect(closedBeforeConfirmation).toBe(false);
  });

  it("passes user messages and interrupts on to the agent", async () => {
    await connect();
    await waitUntilWelcomed();

    controlPlane.send({ type: "deliver_user_message", sequence: 1, messageId: "m", text: "Hi" });
    controlPlane.send({ type: "interrupt_agent" });
    await waitUntil(() => agentRequests.length === 2, "both requests arrive");

    expect(agentRequests).toEqual([
      { type: "deliver_user_message", sequence: 1, messageId: "m", text: "Hi" },
      { type: "interrupt_agent" },
    ]);
  });

  it("sends acknowledgements of user messages on a welcomed connection", async () => {
    await connect();
    await waitUntilWelcomed();
    await pause(20);

    connection.acknowledgeUserMessages(4);
    await waitUntil(() => controlPlane.receivedFrames.length === 1, "the acknowledgement arrives");

    expect(receivedMessagesOnServer()).toEqual([
      { type: "user_messages_delivered", throughSequence: 4 },
    ]);
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

  it("says why the control plane refused it, such as the protocol version it expected", async () => {
    await connect();
    await waitUntil(() => controlPlane.connections.length === 1, "the supervisor connects");
    controlPlane.refuseUpgradesWith(400, 'Protocol version "2" is not supported; expected 3.\n');

    controlPlane.connections[0]?.terminate();
    await waitUntil(() => fatalErrors.length === 1, "the connection fails for good");

    expect(fatalErrors[0]?.message).toContain(
      'HTTP 400: Protocol version "2" is not supported; expected 3.',
    );
  });

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

  it("ignores invalid frames from the control plane", async () => {
    await connect();
    await waitUntilWelcomed();

    controlPlane.connections[0]?.send("not json");
    controlPlane.connections[0]?.send(JSON.stringify({ type: "deliver_user_message", text: "" }));
    controlPlane.send({ type: "interrupt_agent" });
    await waitUntil(() => agentRequests.length === 1, "the valid message arrives");
    await pause(20);

    expect(agentRequests).toEqual([{ type: "interrupt_agent" }]);
  });

  it("drops a connection whose control plane stops answering pings, then reconnects", async () => {
    await connect({
      answersPings: false,
      timing: { heartbeatIntervalInMilliseconds: 20, heartbeatTimeoutInMilliseconds: 60 },
    });

    await waitUntil(() => controlPlane.connections.length >= 2, "the supervisor reconnects");

    expect(fatalErrors).toEqual([]);
  });

  it("fails loudly, instead of dropping events or growing without bound, when too many wait for confirmation", async () => {
    await connect({ refuseWith: 503, timing: { unconfirmedEventsMaximumLength: 200 } });

    for (let eventNumber = 0; eventNumber < 10; eventNumber += 1) {
      connection.sendAgentEvent(runStarted);
    }

    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]?.message).toMatch(/has not confirmed this supervisor's agent events/);
  });

  it("counts events sent but never confirmed towards the limit, not just those never sent", async () => {
    await connect({ confirmsEvents: false, timing: { unconfirmedEventsMaximumLength: 200 } });
    await waitUntilWelcomed();
    await pause(20);

    for (let eventNumber = 0; eventNumber < 10; eventNumber += 1) {
      connection.sendAgentEvent(runStarted);
    }

    expect(fatalErrors).toHaveLength(1);
  });
});
