import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  describeWhyDockerTestsCannotRun,
  dockerTestImage,
  findDockerBridgeGateway,
} from "../test-support/docker-test-environment.js";
import { describeSandboxProviderContract } from "../test-support/sandbox-provider-contract.js";
import { SupervisorConnectionRecorder } from "../test-support/supervisor-connection-recorder.js";
import { createDockerCommandRunner } from "./docker-cli.js";
import { hostAlias } from "./docker-create-arguments.js";
import { DockerSandboxProvider } from "./docker-sandbox-provider.js";

/**
 * The contract against real containers from the sandbox image, whose
 * supervisors (running the fake agent) connect out to a recorder standing in
 * for the control plane.
 */

const supervisorConnectionTimeoutInMilliseconds = 30_000;
const docker = createDockerCommandRunner("docker");
const dockerCommandOptions = { timeoutInMilliseconds: 30_000 };
const asAgent = ["--user", "barrack-agent"];

/** `docker exec` as the agent's user, reporting the exit code rather than throwing on it. */
function runAsAgentThroughDocker(
  sandboxId: string,
  shellCommand: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["exec", ...asAgent, sandboxId, "sh", "-c", shellCommand],
      { timeout: 30_000, encoding: "utf8" },
      (error, standardOutput, standardError) => {
        const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ exitCode, output: `${standardOutput}${standardError}` });
      },
    );
  });
}

describeSandboxProviderContract({
  providerName: "Docker",
  unavailableReason: describeWhyDockerTestsCannotRun(),
  async setUp() {
    const recorder = await SupervisorConnectionRecorder.listen(findDockerBridgeGateway());
    const settings = {
      image: dockerTestImage,
      cpuLimit: 1,
      memoryLimitInMebibytes: 512,
      processLimit: 256,
      stopTimeoutInSeconds: 10,
      servicePorts: [],
      dockerExecutable: "docker",
      network: undefined,
    };
    const provider = new DockerSandboxProvider(settings);
    return {
      provider,
      reopenProvider: () => new DockerSandboxProvider(settings),
      unknownSandboxId: randomBytes(32).toString("hex"),
      supervisorEnvironmentFor: (threadId) => ({
        BARRACK_CONTROL_PLANE_URL: `ws://${hostAlias}:${recorder.port}`,
        BARRACK_THREAD_ID: threadId,
        BARRACK_AGENT_HARNESS: "fake",
      }),
      waitForSupervisorLaunches: (threadId, launchCount) =>
        recorder.waitForConnections(
          threadId,
          launchCount,
          supervisorConnectionTimeoutInMilliseconds,
        ),
      // The workspace belongs to the agent's user, and `docker exec` would
      // otherwise run as the image's default user, the supervisor's.
      async writeFile(sandboxId, path, content) {
        await docker(
          ["exec", ...asAgent, "--interactive", sandboxId, "sh", "-c", 'cat > "$1"', "sh", path],
          { ...dockerCommandOptions, standardInput: content },
        );
      },
      readFile: (sandboxId, path) =>
        docker(["exec", ...asAgent, sandboxId, "cat", path], dockerCommandOptions),
      readSecretAsSupervisor: (sandboxId, secretName) =>
        docker(
          [
            "exec",
            ...["--user", "barrack-supervisor"],
            sandboxId,
            "sh",
            "-c",
            'cat "$BARRACK_SUPERVISOR_SECRETS_DIRECTORY/$1"',
            "sh",
            secretName,
          ],
          dockerCommandOptions,
        ),
      describeSandboxAsProviderReportsIt: (sandboxId) =>
        docker(["container", "inspect", sandboxId], dockerCommandOptions),
      agentCommands: { run: runAsAgentThroughDocker },
      dispose: () => recorder.close(),
    };
  },
});
