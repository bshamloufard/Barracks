// The functions passed to the browser run in its pages, where the DOM is.
/// <reference lib="dom" />
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clientConfigurationPath, clientConfigurationSchema } from "@barrack/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BrowserPage,
  describeWhyBrowserCannotRun,
  launchSignedInBrowser,
} from "./support/desktop-browser.js";
import { fakeDesktopSize, writeFakeDesktopCommand } from "./support/fake-vnc-desktop.js";
import {
  findFreePort,
  type RunningControlPlane,
  startControlPlane,
  testClientOrigin,
} from "./support/local-system.js";
import { repositoryRoot, tsxLoaderUrl } from "./support/service-process.js";
import { createThread } from "./support/threads-api.js";

/**
 * The built web client, served by the real control plane with its
 * Content-Security-Policy, runs in a real browser without the policy
 * refusing anything: the thread list, a thread's conversation over its
 * WebSocket, the live desktop drawn by noVNC (a Tight JPEG screen and a
 * cursor, both shown through `data:` images, from a stand-in VNC server in
 * a local-process sandbox), and signing out and asking for a sign-in email
 * at the Supabase project (a stand-in). Every violation the page reports is
 * collected; at the end the page is made to break the policy on purpose, to
 * show that the collection works and the policy is enforced, not merely
 * reported.
 *
 * Needs Playwright with its Chromium where Node finds it, but no Docker.
 */

const unavailableReason = describeWhyBrowserCannotRun();
const timeoutInMilliseconds = 120_000;
const laptop = { width: 1280, height: 1000 };
/** The stand-in desktop's colour, which the viewer's canvas must show. */
const screenColour = [32, 160, 96] as const;

type PolicyViolations = { barrackPolicyViolations: string[] };

/** Builds the web client as `pnpm build` does, into a directory of the test's own. */
function buildWebClient(outputDirectory: string): Promise<void> {
  const webDirectory = path.join(repositoryRoot, "apps/web");
  const build = spawn(
    process.execPath,
    [
      path.join(webDirectory, "node_modules/vite/bin/vite.js"),
      "build",
      "--outDir",
      outputDirectory,
      "--emptyOutDir",
    ],
    {
      cwd: webDirectory,
      // Vitest sets NODE_ENV to "test", which would build React's development code instead.
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let errors = "";
  build.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString("utf8");
  });
  return new Promise((resolve, reject) => {
    build.once("error", reject);
    build.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`vite build failed (${code}): ${errors}`)),
    );
  });
}

/** A JPEG of one colour, encoded by the browser, for the stand-in desktop to show. */
async function makeScreenJpeg(page: BrowserPage): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    ({ colour, size }) => {
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("The browser gave no 2D canvas.");
      }
      context.fillStyle = `rgb(${colour.join(",")})`;
      context.fillRect(0, 0, size.width, size.height);
      return canvas.toDataURL("image/jpeg", 0.95);
    },
    { colour: [...screenColour], size: fakeDesktopSize },
  );
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

/** Whether most of the viewer's canvas shows the desktop's colour. */
function isScreenColourShown(page: BrowserPage): Promise<boolean> {
  return page.evaluate(
    (colour) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '[data-testid="desktop-screen"] canvas',
      );
      const context = canvas?.getContext("2d");
      if (canvas == null || context == null || canvas.width === 0 || canvas.height === 0) {
        return false;
      }
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let matching = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (
          [0, 1, 2].every(
            (channel) => Math.abs((data[index + channel] ?? 0) - (colour[channel] ?? 0)) < 16,
          )
        ) {
          matching += 1;
        }
      }
      return matching > data.length / 4 / 2;
    },
    [...screenColour],
  );
}

function readViolations(page: BrowserPage): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as PolicyViolations).barrackPolicyViolations,
    undefined,
  );
}

if (unavailableReason !== undefined) {
  describe.skip(`the web client under its Content-Security-Policy (skipped: ${unavailableReason})`, () => {
    it("is not tested here", () => {});
  });
} else {
  describe("the web client under its Content-Security-Policy, in a browser", {
    timeout: timeoutInMilliseconds,
  }, () => {
    let workDirectory: string;
    let controlPlane: RunningControlPlane;
    let browser: Awaited<ReturnType<typeof launchSignedInBrowser>>;
    let page: BrowserPage;
    let webOrigin: string;
    let supabaseUrl: string;
    const consoleReports: string[] = [];
    const requestedUrls: string[] = [];

    beforeAll(async () => {
      workDirectory = await mkdtemp(path.join(tmpdir(), "barrack-web-client-policy-"));
      const webClientDirectory = path.join(workDirectory, "web");
      const jpegPath = path.join(workDirectory, "screen.jpg");
      await buildWebClient(webClientDirectory);
      const port = await findFreePort("localhost");
      webOrigin = `http://localhost:${port}`;
      const vncPort = await findFreePort("127.0.0.1");
      controlPlane = await startControlPlane({
        // Not 127.0.0.1, so that sign-in goes through the stand-in Supabase project.
        host: "localhost",
        port,
        sandboxes: {
          kind: "local-process",
          supervisorCommand: [
            "/usr/bin/env",
            `BARRACK_DESKTOP_COMMAND=${await writeFakeDesktopCommand(workDirectory, jpegPath)}`,
            "DISPLAY=:99",
            `BARRACK_DESKTOP_VNC_PORT=${vncPort}`,
            process.execPath,
            "--import",
            tsxLoaderUrl,
            path.join(repositoryRoot, "apps/sandbox-supervisor/src/main.ts"),
          ],
        },
        environment: {
          BARRACK_WEB_CLIENT_DIRECTORY: webClientDirectory,
          BARRACK_ALLOWED_CLIENT_ORIGINS: `${testClientOrigin},${webOrigin}`,
          BARRACK_SANDBOX_CONTROL_PLANE_URL: `ws://localhost:${port}`,
        },
      });
      const configuration = clientConfigurationSchema.parse(
        await (await fetch(`${controlPlane.httpBaseUrl}${clientConfigurationPath}`)).json(),
      );
      if (configuration.authentication.method !== "supabase") {
        throw new Error("The test control plane should sign in through Supabase.");
      }
      supabaseUrl = configuration.authentication.supabaseUrl;
      browser = await launchSignedInBrowser({
        origin: webOrigin,
        supabaseUrl,
        accessToken: controlPlane.accessToken,
      });
      await writeFile(jpegPath, await makeScreenJpeg(await browser.openPage(laptop)));
      page = await browser.openPage(laptop);
      await page.addInitScript(() => {
        const violations: string[] = [];
        (window as unknown as PolicyViolations).barrackPolicyViolations = violations;
        document.addEventListener("securitypolicyviolation", (event) =>
          violations.push(`${event.effectiveDirective} refused ${event.blockedURI}`),
        );
      });
      page.on("console", (message) => {
        if (message.text().includes("Content Security Policy")) {
          consoleReports.push(message.text());
        }
      });
      page.on("request", (request) => requestedUrls.push(request.url()));
    }, timeoutInMilliseconds);

    afterAll(async () => {
      await browser?.close();
      await controlPlane?.stop();
      if (workDirectory !== undefined) {
        await rm(workDirectory, { recursive: true, force: true });
      }
    }, timeoutInMilliseconds);

    it("is sent with a policy naming the installation's origin and its Supabase project", async () => {
      const response = await fetch(`${webOrigin}/`);

      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy).toContain(`connect-src 'self' ws://end-to-end-test.localhost ws://localhost:`);
      expect(policy).toContain(new URL(supabaseUrl).origin);
      expect(policy).not.toContain("unsafe");
    });

    it("shows a thread's conversation and its live desktop without refusing anything", async () => {
      const { threadId } = await createThread(controlPlane);

      await page.goto(`${webOrigin}/?thread=${threadId}`);
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="desktop-status"]')
            ?.textContent?.startsWith("Watching the agent's desktop.") === true,
        undefined,
        { timeout: 60_000 },
      );
      await page.waitForFunction(
        () => document.querySelector('[data-testid="desktop-screen"] canvas') !== null,
        undefined,
        { timeout: 10_000 },
      );
      const deadline = Date.now() + 20_000;
      while (!(await isScreenColourShown(page)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // Over the screen, so that the browser loads the desktop's cursor image.
      const screen = await page.getByTestId("desktop-screen").boundingBox();
      await page.mouse.move((screen?.x ?? 0) + 100, (screen?.y ?? 0) + 100);
      await page.getByLabel("Message to the agent").fill("Reply under the policy");
      await page.getByRole("button", { name: "Send" }).click();
      await page.waitForFunction(
        () =>
          [
            ...document.querySelectorAll(".assistant-message:not([aria-busy]) .assistant-text"),
          ].some((element) => element.textContent?.includes("Reply under the policy") === true),
        undefined,
        { timeout: 20_000 },
      );

      expect(await isScreenColourShown(page)).toBe(true);
      expect(await readViolations(page)).toEqual([]);
      expect(consoleReports).toEqual([]);
    });

    it("signs out and asks Supabase for a sign-in email without refusing anything", async () => {
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.getByLabel("Sign in with your email address").fill("tester@example.com");
      await page.getByRole("button", { name: "Email me a sign-in link" }).click();
      await page.waitForFunction(
        () => document.querySelector('[role="alert"], .sign-in-form p') !== null,
        undefined,
        { timeout: 20_000 },
      );

      expect(requestedUrls.some((url) => url.startsWith(`${supabaseUrl}/auth/v1/otp`))).toBe(true);
      expect(await readViolations(page)).toEqual([]);
      expect(consoleReports).toEqual([]);
    });

    it("refuses what the policy does not allow, as the checks above rely on", async () => {
      await page.evaluate(() => {
        void fetch("http://127.0.0.1:9/elsewhere").catch(() => undefined);
        new Image().src = "http://127.0.0.1:9/elsewhere.png";
      }, undefined);
      await page.waitForFunction(
        () => (window as unknown as PolicyViolations).barrackPolicyViolations.length >= 2,
        undefined,
        { timeout: 10_000 },
      );

      expect((await readViolations(page)).sort()).toEqual([
        "connect-src refused http://127.0.0.1:9/elsewhere",
        "img-src refused http://127.0.0.1:9/elsewhere.png",
      ]);
    });
  });
}
