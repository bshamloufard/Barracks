import { closeCodes } from "@barrack/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningControlPlane, startControlPlane } from "./support/local-system.js";
import { RawDesktopViewer } from "./support/raw-desktop-viewer.js";
import { TestClient } from "./support/test-client.js";
import { createThread } from "./support/threads-api.js";

/**
 * A local-process sandbox, as `pnpm dev` runs one, has no desktop: several
 * sandboxes on one machine would share one display and one port, and the
 * agent would see the developer's own screen. The thread page is told so,
 * and the agent's computer tool says so too.
 */

let controlPlane: RunningControlPlane;
let client: TestClient;
let threadId: string;

beforeAll(async () => {
  controlPlane = await startControlPlane({
    sandboxes: { kind: "local-process" },
    // Even if the machine running the tests has a display of its own.
    environment: { DISPLAY: ":0" },
  });
  ({ threadId } = await createThread(controlPlane));
  client = await TestClient.connect(controlPlane, threadId, 0);
  await client.waitUntilSupervisorIsConnected();
});

afterAll(async () => {
  await client?.close();
  await controlPlane?.stop();
});

describe("a local-process sandbox's desktop", () => {
  it("is answered as missing, saying the sandbox has none", async () => {
    // The supervisor reports its desktop just after its welcome.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const viewer = await RawDesktopViewer.open(
      controlPlane.webSocketBaseUrl,
      threadId,
      controlPlane.accessToken,
    );

    expect(await viewer.closed).toBe(closeCodes.desktopUnavailable);
    expect(viewer.messages).toEqual([
      {
        type: "desktop_unavailable",
        reason: "no_desktop",
        explanation: expect.stringMatching(/^This sandbox has no desktop/),
      },
    ]);
  });

  it("leaves the agent's computer tool saying there is no screen to use", async () => {
    client.sendUserMessage("[desktop]");
    await client.waitUntilRunsHaveSettled(1);

    const finished = client
      .threadEvents()
      .find((message) => message.event.type === "tool_execution_finished");
    expect(finished?.event).toMatchObject({
      toolName: "computer",
      isError: true,
      output: { text: expect.stringMatching(/no desktop/) },
    });
  });
});
