import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeWhyDockerTestCannotRun, sandboxImage } from "./support/docker-environment.js";

/**
 * The sandbox image's desktop, checked in a container started with the
 * capabilities the Docker provider gives a sandbox but without a
 * supervisor, so each part can be tried alone, as the agent's user.
 */

const unavailableReason = describeWhyDockerTestCannotRun();
const containerName = `barrack-desktop-image-test-${randomUUID().slice(0, 8)}`;

/** Prints "answering" when a VNC server greets on port 5900. */
const probeVncServer = `node -e '
const socket = require("net").connect(5900, "127.0.0.1");
socket.once("data", (data) => { console.log(String(data).startsWith("RFB ") ? "answering" : "not VNC"); process.exit(0); });
socket.once("error", () => { console.log("not answering"); process.exit(0); });'`;

function runAsAgent(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "--user", "barrack-agent", containerName, "sh", "-c", script],
    { encoding: "utf8", timeout: 60_000 },
  );
}

if (unavailableReason !== undefined) {
  describe.skip(`the sandbox image's desktop (skipped: ${unavailableReason})`, () => {
    it("is not tested here", () => {});
  });
} else {
  describe("the sandbox image's desktop", { timeout: 120_000 }, () => {
    beforeAll(() => {
      execFileSync(
        "docker",
        [
          ...["run", "--detach", "--name", containerName],
          ...["--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID"],
          ...["--entrypoint", "sleep", sandboxImage, "infinity"],
        ],
        { stdio: "ignore", timeout: 60_000 },
      );
    }, 120_000);

    afterAll(() => {
      execFileSync("docker", ["rm", "--force", containerName], {
        stdio: "ignore",
        timeout: 60_000,
      });
    });

    it("starts though a stopped sandbox left an X lock naming a process that is alive", () => {
      // Process 1, the container's first process, is alive: a stale lock
      // naming it is what a sandbox started again after a stop can hold.
      const output = runAsAgent(
        [
          "echo 1 > /tmp/.X1-lock",
          "(sleep 4 | barrack-desktop > /dev/null 2>&1) &",
          "sleep 2",
          probeVncServer,
          "cat /tmp/.X1-lock",
          "wait",
          probeVncServer,
        ].join("\n"),
      );

      const [whileRunning, lockHolder, afterInputClosed] = output.trim().split(/\s+/);
      expect(whileRunning).toBe("answering");
      expect(lockHolder).not.toBe("1");
      expect(afterInputClosed).toBe("not");
    });

    it("has Firefox, with its policy, for the agent", () => {
      const output = runAsAgent(
        "firefox --version && cat /etc/firefox/policies/policies.json && command -v xdotool",
      );

      expect(output).toMatch(/^Mozilla Firefox \d+/);
      expect(
        JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)),
      ).toMatchObject({
        policies: { SkipTermsOfUse: true, DisableAppUpdate: true, DisableTelemetry: true },
      });
      expect(output.trim().endsWith("/usr/bin/xdotool")).toBe(true);
    });

    it("lets the agent read, but not write, who holds the desktop", () => {
      const output = runAsAgent(
        "ls -ld /run/barrack-desktop; touch /run/barrack-desktop/control 2>&1 || echo refused",
      );

      expect(output).toMatch(/^drwxr-xr-x \d+ barrack-supervisor barrack-supervisor/);
      expect(output.trim().endsWith("refused")).toBe(true);
    });
  });
}
