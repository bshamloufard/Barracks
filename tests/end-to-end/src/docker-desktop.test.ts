// The functions passed to the browser run in its pages, where the DOM is.
/// <reference lib="dom" />
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  desktopTestPageColours,
  desktopTriggers,
  type MockModelServer,
  startMockModelServer,
} from "@barrack/mock-model-server";
import {
  clientConfigurationPath,
  clientConfigurationSchema,
  closeCodes,
  type ToolExecutionFinishedEvent,
} from "@barrack/protocol";
import { createSandboxProvider } from "@barrack/sandbox-providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BrowserPage,
  describeWhyBrowserCannotRun,
  launchSignedInBrowser,
} from "./support/desktop-browser.js";
import {
  type DesktopTestPages,
  startDesktopTestPages,
  textBoxColour,
} from "./support/desktop-test-pages.js";
import {
  describeWhyDockerTestCannotRun,
  findDockerBridgeGateway,
  findSandboxIdOf,
  testDockerSettings,
  writeFileInSandboxAsAgent,
} from "./support/docker-environment.js";
import {
  findFreePort,
  type RunningControlPlane,
  startControlPlane,
  testClientOrigin,
} from "./support/local-system.js";
import { RawDesktopViewer } from "./support/raw-desktop-viewer.js";
import { repositoryRoot } from "./support/service-process.js";
import { TestClient } from "./support/test-client.js";
import {
  createThread,
  saveModelCredential,
  stopThread,
  waitUntilSandboxIs,
} from "./support/threads-api.js";

/**
 * Milestone 5's acceptance test: the live desktop and computer use, in a
 * container from the sandbox image, with the real Pi against a mock model
 * that looks at the screenshots it is sent, through the real control plane,
 * watched in the real web client in a real browser.
 *
 * (a) The user watches the agent open Firefox in its sandbox and click
 *     through two pages served from this machine; the pages' server sees
 *     the clicks, and the viewer's canvas shows the finished page.
 * (b) The user takes control and clicks and types into the page; it
 *     arrives; meanwhile the agent's computer tool refuses to click, and
 *     uses the desktop again once control is given back.
 * (c) A second viewer watches; the keys it sends are dropped.
 * (d) The thread is stopped; the page says so and offers to wake it; woken,
 *     the desktop is back.
 * (e) Another signed-in user cannot open the desktop: it is answered as a
 *     thread that does not exist.
 *
 * Screenshots of the viewer are saved to BARRACK_DESKTOP_SCREENSHOTS when set.
 */

const testTimeoutInMilliseconds = 600_000;
const unavailableReason = describeWhyDockerTestCannotRun() ?? describeWhyBrowserCannotRun();
const piAgentDirectory = "/var/lib/barrack/state/pi/agent";
const { BARRACK_DESKTOP_SCREENSHOTS: screenshotDirectory } = process.env;
const laptop = { width: 1280, height: 1000 };
const phone = { width: 390, height: 844 };
const watchingText = "Watching the agent's desktop.";

/** A mock model that takes images, as the computer tool needs. */
function describeMockModel(modelServer: MockModelServer): string {
  const baseUrl = `http://host.docker.internal:${modelServer.port}/v1`;
  const model = {
    id: "mock-1",
    name: "Mock 1",
    input: ["text", "image"],
    contextWindow: 100_000,
    maxTokens: 4_096,
  };
  return JSON.stringify({
    providers: { mock: { baseUrl, api: "openai-completions", models: [model] } },
  });
}

async function saveScreenshot(page: BrowserPage, name: string): Promise<void> {
  if (screenshotDirectory === undefined) {
    return;
  }
  mkdirSync(screenshotDirectory, { recursive: true });
  // The conversation keeps itself scrolled to its end; the desktop is above it.
  await page.evaluate(
    (selector) => document.querySelector(selector)?.scrollIntoView({ block: "center" }),
    ".desktop-panel",
  );
  await page.screenshot({ path: path.join(screenshotDirectory, `${name}.png`) });
}

async function waitForDesktopStatus(page: BrowserPage, text: string): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector('[data-testid="desktop-status"]')
        ?.textContent?.startsWith(expected) === true,
    text,
    { timeout: 60_000 },
  );
}

/**
 * Where on the page the viewer's canvas shows pixels of a colour, found by
 * reading the canvas itself: what the user sees, not what the sandbox has.
 */
async function findOnCanvas(
  page: BrowserPage,
  rgb: readonly number[],
): Promise<{ pageX: number; pageY: number; pixelCount: number } | undefined> {
  return page.evaluate((colour) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="desktop-screen"] canvas',
    );
    const context = canvas?.getContext("2d");
    if (canvas === null || canvas === undefined || context === null || context === undefined) {
      return undefined;
    }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let sumX = 0;
    let sumY = 0;
    let pixelCount = 0;
    for (let index = 0; index < data.length; index += 4) {
      const isClose = [0, 1, 2].every(
        (channel) => Math.abs((data[index + channel] ?? 0) - (colour[channel] ?? 0)) < 16,
      );
      if (isClose) {
        sumX += (index / 4) % canvas.width;
        sumY += Math.floor(index / 4 / canvas.width);
        pixelCount += 1;
      }
    }
    if (pixelCount < 500) {
      return undefined;
    }
    const box = canvas.getBoundingClientRect();
    return {
      pageX: box.left + ((sumX / pixelCount) * box.width) / canvas.width,
      pageY: box.top + ((sumY / pixelCount) * box.height) / canvas.height,
      pixelCount,
    };
  }, rgb);
}

async function waitUntil(
  description: string,
  isDone: () => boolean | Promise<boolean>,
  timeout = 60_000,
) {
  const deadline = Date.now() + timeout;
  while (!(await isDone())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting until ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function computerResults(client: TestClient): ToolExecutionFinishedEvent[] {
  return client
    .threadEvents()
    .flatMap(({ event }) =>
      event.type === "tool_execution_finished" && event.toolName === "computer" ? [event] : [],
    );
}

if (unavailableReason !== undefined) {
  describe.skip(`the live desktop in Docker (skipped: ${unavailableReason})`, () => {
    it("is not tested here", () => {});
  });
} else {
  describe("the live desktop in Docker, watched in a browser", {
    timeout: testTimeoutInMilliseconds,
  }, () => {
    const provider = createSandboxProvider({ kind: "docker", docker: testDockerSettings });
    let controlPlane: RunningControlPlane;
    let modelServer: MockModelServer;
    let pages: DesktopTestPages;
    let browser: Awaited<ReturnType<typeof launchSignedInBrowser>>;
    let client: TestClient;
    let laptopPage: BrowserPage;
    let threadId: string;
    let pageUrl: string;

    beforeAll(async () => {
      const hostAddress = findDockerBridgeGateway();
      modelServer = await startMockModelServer(hostAddress);
      pages = await startDesktopTestPages(hostAddress);
      const port = await findFreePort(hostAddress);
      const webOrigin = `http://${hostAddress}:${port}`;
      controlPlane = await startControlPlane({
        host: hostAddress,
        port,
        sandboxes: { kind: "docker" },
        agent: { harness: "pi" },
        environment: {
          BARRACK_WEB_CLIENT_DIRECTORY: path.join(repositoryRoot, "apps/web/dist"),
          BARRACK_ALLOWED_CLIENT_ORIGINS: `${testClientOrigin},${webOrigin}`,
          // Firefox wants more memory and processes than the agent alone.
          BARRACK_DOCKER_MEMORY_MEBIBYTES: "2048",
          BARRACK_DOCKER_PROCESS_LIMIT: "1024",
        },
      });
      await saveModelCredential(controlPlane, "mock", "mock-key-of-the-test-user");
      ({ threadId } = await createThread(controlPlane, "mock/mock-1"));
      await waitUntilSandboxIs(controlPlane, threadId, "running");
      client = await TestClient.connect(controlPlane, threadId, 0);
      await client.waitUntilSupervisorIsConnected();
      writeFileInSandboxAsAgent(
        findSandboxIdOf(threadId),
        `${piAgentDirectory}/models.json`,
        describeMockModel(modelServer),
      );
      const configuration = clientConfigurationSchema.parse(
        await (await fetch(`${controlPlane.httpBaseUrl}${clientConfigurationPath}`)).json(),
      );
      if (configuration.authentication.method !== "supabase") {
        throw new Error("The test control plane should verify real tokens.");
      }
      browser = await launchSignedInBrowser({
        origin: webOrigin,
        supabaseUrl: configuration.authentication.supabaseUrl,
        accessToken: controlPlane.accessToken,
      });
      pageUrl = `${webOrigin}/?thread=${threadId}`;
    }, testTimeoutInMilliseconds);

    afterAll(async () => {
      await browser?.close();
      await client?.close();
      try {
        await provider.destroy(findSandboxIdOf(threadId));
      } catch (error) {
        console.warn(`Could not destroy the sandbox of thread ${threadId}:`, error);
      }
      await pages?.close();
      await modelServer?.close();
      await controlPlane?.stop();
    }, testTimeoutInMilliseconds);

    it("(a) shows the user the agent opening a browser and clicking through a page", async () => {
      laptopPage = await browser.openPage(laptop);
      await laptopPage.goto(pageUrl);
      await waitForDesktopStatus(laptopPage, watchingText);

      client.sendUserMessage(`${desktopTriggers.browse}${pages.startUrl}`);
      await waitUntil("the agent's browser shows the first page", async () => {
        return (
          (await findOnCanvas(laptopPage, desktopTestPageColours.firstPageButton)) !== undefined
        );
      });
      await saveScreenshot(laptopPage, "01-watching-the-agent-open-firefox");
      await client.waitUntilRunsHaveSettled(1);

      expect(pages.requests).toEqual(
        expect.arrayContaining(["GET /start", "GET /next", "POST /clicked"]),
      );
      const lastMessage = client
        .threadEvents()
        .flatMap(({ event }) => (event.type === "assistant_message" ? [event] : []))
        .at(-1);
      expect(lastMessage?.content).toEqual([
        { type: "text", text: expect.stringMatching(/^Clicked through both pages/) },
      ]);
      await waitUntil("the viewer shows the finished page", async () => {
        return (await findOnCanvas(laptopPage, desktopTestPageColours.finishedPage)) !== undefined;
      });
      await saveScreenshot(laptopPage, "02-the-agent-clicked-through-the-page");
      // The history holds what the agent did on the desktop in words, and no picture.
      const history = JSON.stringify(client.threadEvents());
      expect(history).not.toMatch(/data:image|iVBORw0KGgo/);
      expect(
        computerResults(client).some((event) => event.output.text.includes("[image: image/png]")),
      ).toBe(true);
    });

    it("(b) lets the user take control and type, while the agent's computer tool stands back", async () => {
      await laptopPage.getByRole("button", { name: "Take control" }).click();
      await waitForDesktopStatus(laptopPage, "You have control");
      const textBox = await findOnCanvas(laptopPage, textBoxColour);
      if (textBox === undefined) {
        throw new Error("The viewer does not show the page's text box.");
      }
      await laptopPage.mouse.click(textBox.pageX, textBox.pageY);
      await laptopPage.keyboard.type("typed by the user", { delay: 30 });
      await waitUntil(
        "the page receives what the user typed",
        () => pages.typedText() === "typed by the user",
      );

      client.sendUserMessage(desktopTriggers.click);
      await client.waitUntilRunsHaveSettled(2);
      const refused = computerResults(client).at(-1);
      await saveScreenshot(laptopPage, "03-the-user-in-control");

      await laptopPage.getByRole("button", { name: "Give control back" }).click();
      await waitForDesktopStatus(laptopPage, watchingText);
      client.sendUserMessage(desktopTriggers.click);
      await client.waitUntilRunsHaveSettled(3);
      const allowed = computerResults(client).at(-1);

      expect(refused).toMatchObject({
        isError: true,
        output: { text: expect.stringMatching(/^The user has taken control of the desktop/) },
      });
      expect(allowed).toMatchObject({
        isError: false,
        output: { text: expect.stringMatching(/^Clicked the left button at \(640, 400\)/) },
      });
    });

    it("(c) lets a second viewer watch at the same time, and drops what it types", async () => {
      const phonePage = await browser.openPage(phone);
      await phonePage.goto(pageUrl);
      await waitForDesktopStatus(phonePage, watchingText);
      const textBox = await findOnCanvas(laptopPage, textBoxColour);
      if (textBox === undefined) {
        throw new Error("The viewer does not show the page's text box.");
      }
      await laptopPage.getByRole("button", { name: "Take control" }).click();
      await waitForDesktopStatus(laptopPage, "You have control");
      await waitForDesktopStatus(phonePage, "Watching. Another of your windows has control");
      await laptopPage.mouse.click(textBox.pageX, textBox.pageY);
      const intruder = await RawDesktopViewer.open(
        controlPlane.webSocketBaseUrl,
        threadId,
        controlPlane.accessToken,
      );
      await intruder.startVnc();

      // The click put the caret where it landed, within the text.
      await laptopPage.keyboard.press("End");
      intruder.typeKeys(" from a watcher");
      await laptopPage.keyboard.type(", and more", { delay: 30 });
      await waitUntil("the page receives the controlling viewer's text", () =>
        pages.typedText().endsWith(", and more"),
      );
      await saveScreenshot(phonePage, "04-a-phone-watching");
      intruder.close();
      await laptopPage.getByRole("button", { name: "Give control back" }).click();

      expect(pages.typedText()).toBe("typed by the user, and more");
    });

    it("(d) says the desktop is stopped with its sandbox, offers to wake it, and brings it back", async () => {
      expect((await stopThread(controlPlane, threadId)).status).toBe(202);
      await waitUntilSandboxIs(controlPlane, threadId, "stopped");
      await waitForDesktopStatus(laptopPage, "The sandbox is stopped");
      await saveScreenshot(laptopPage, "05-stopped-with-an-offer-to-wake");

      await laptopPage.getByRole("button", { name: "Wake the sandbox" }).click();
      await waitUntilSandboxIs(controlPlane, threadId, "running");
      await waitForDesktopStatus(laptopPage, watchingText);
      await saveScreenshot(laptopPage, "06-woken-desktop-back");

      const viewer = await RawDesktopViewer.open(
        controlPlane.webSocketBaseUrl,
        threadId,
        controlPlane.accessToken,
      );
      await viewer.startVnc();
      viewer.close();
    });

    it("(e) answers another signed-in user's request for the desktop as a thread that does not exist", async () => {
      const otherUser = await controlPlane.signInSecondUser();

      const othersThread = await RawDesktopViewer.open(
        controlPlane.webSocketBaseUrl,
        threadId,
        otherUser,
      );
      const missingThread = await RawDesktopViewer.open(
        controlPlane.webSocketBaseUrl,
        "thread-that-was-never-created",
        otherUser,
      );

      expect(await othersThread.closed).toBe(closeCodes.threadNotFound);
      expect(await missingThread.closed).toBe(closeCodes.threadNotFound);
      expect(othersThread.messages).toEqual([]);
      expect(missingThread.messages).toEqual([]);
    });
  });
}
