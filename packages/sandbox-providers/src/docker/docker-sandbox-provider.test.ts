import { describe, expect, it } from "vitest";
import {
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
  SandboxRefusedError,
} from "../sandbox-provider-errors.js";
import { DockerCommandFailure, type DockerCommandOptions } from "./docker-cli.js";
import type { DockerProviderSettings } from "./docker-run-arguments.js";
import { DockerSandboxProvider } from "./docker-sandbox-provider.js";

/**
 * The provider's own decisions, with the docker command replaced by a script
 * of answers. Real containers are covered by the contract tests.
 */

const settings: DockerProviderSettings = {
  image: "barrack-sandbox:dev",
  cpuLimit: 1,
  memoryLimitInMebibytes: 512,
  processLimit: 256,
  stopTimeoutInSeconds: 10,
  servicePorts: [6080],
  dockerExecutable: "docker",
  network: undefined,
};

const barrackContainerId = "b".repeat(64);
const otherContainerId = "c".repeat(64);

type RecordedCommand = { commandArguments: readonly string[]; options: DockerCommandOptions };

function inspectOutput(id: string, labels: Record<string, string>): string {
  return JSON.stringify({
    Id: id,
    State: { Status: "running", ExitCode: 0, OOMKilled: false, Error: "" },
    Config: { Labels: labels },
  });
}

/** A docker command that knows one Barrack container and one unrelated container. */
function createScriptedDocker() {
  const commands: RecordedCommand[] = [];
  const answer = (commandArguments: readonly string[]): string => {
    const [command, subcommand] = commandArguments;
    const target = commandArguments.at(-1) ?? "";
    if (command === "container" && subcommand === "inspect") {
      if (target === barrackContainerId || target === "barrack-thread-taken") {
        return inspectOutput(barrackContainerId, { "barrack.sandbox": "true" });
      }
      if (target === otherContainerId) {
        return inspectOutput(otherContainerId, {});
      }
      throw new DockerCommandFailure("exited-with-error", `Error: No such object: ${target}`);
    }
    if (command === "run" && commandArguments.includes("barrack-thread-taken")) {
      throw new DockerCommandFailure(
        "exited-with-error",
        `Conflict. The container name "/barrack-thread-taken" is already in use by container "${barrackContainerId}".`,
      );
    }
    if (command === "run") {
      return `${"d".repeat(64)}\n`;
    }
    if (command === "container" && subcommand === "port") {
      return "127.0.0.1:49153\n";
    }
    return "";
  };
  const docker = async (commandArguments: readonly string[], options: DockerCommandOptions) => {
    commands.push({ commandArguments, options });
    return answer(commandArguments);
  };
  return { docker, commands };
}

const leftoverId = "e".repeat(64);

/**
 * A docker command whose `run` creates the container and then fails to start
 * it, as an impossible memory limit does, and whose removal of that
 * container can be made to fail.
 */
function createDockerWhoseRunLeavesAContainer({ removalFails }: { removalFails: boolean }) {
  const commands: (readonly string[])[] = [];
  const docker = async (commandArguments: readonly string[]) => {
    commands.push(commandArguments);
    const [command, subcommand] = commandArguments;
    if (command === "run") {
      throw new DockerCommandFailure("exited-with-error", "Error: Minimum memory limit allowed");
    }
    if (command === "container" && subcommand === "inspect") {
      return inspectOutput(leftoverId, { "barrack.sandbox": "true" });
    }
    if (removalFails) {
      throw new DockerCommandFailure("exited-with-error", "Cannot connect to the Docker daemon");
    }
    return "";
  };
  return { docker, commands };
}

describe("the Docker sandbox provider", () => {
  it("passes the supervisor's environment to docker through the CLI's environment only", async () => {
    const { docker, commands } = createScriptedDocker();
    const provider = new DockerSandboxProvider(settings, docker);
    const supervisorEnvironment = { BARRACK_SUPERVISOR_TOKEN: "secret-value" };

    const { sandboxId } = await provider.create({ threadId: "thread-1", supervisorEnvironment });

    const run = commands.find(({ commandArguments }) => commandArguments[0] === "run");
    expect(sandboxId).toBe("d".repeat(64));
    expect(run?.options.extraEnvironment).toEqual(supervisorEnvironment);
    expect(run?.commandArguments.join(" ")).not.toContain("secret-value");
  });

  it("refuses environment variable names that would reconfigure the docker command", async () => {
    const provider = new DockerSandboxProvider(settings, createScriptedDocker().docker);

    const creation = provider.create({
      threadId: "thread-1",
      supervisorEnvironment: { DOCKER_HOST: "tcp://elsewhere:2375" },
    });

    await expect(creation).rejects.toThrow(SandboxRefusedError);
  });

  it("reports the thread's existing sandbox when its container name is taken", async () => {
    const provider = new DockerSandboxProvider(settings, createScriptedDocker().docker);

    const creation = provider.create({ threadId: "taken", supervisorEnvironment: {} });

    await expect(creation).rejects.toThrow(SandboxAlreadyExistsError);
    await expect(creation).rejects.toMatchObject({ existingSandboxId: barrackContainerId });
  });

  it("removes the container a failed run left behind and reports the run's failure", async () => {
    const { docker, commands } = createDockerWhoseRunLeavesAContainer({ removalFails: false });
    const provider = new DockerSandboxProvider(settings, docker);

    const creation = provider.create({ threadId: "half-created", supervisorEnvironment: {} });

    await expect(creation).rejects.toThrow(SandboxRefusedError);
    await expect(creation).rejects.toThrow(/Minimum memory limit/);
    expect(commands.at(-1)).toEqual(["container", "rm", "--force", "--volumes", leftoverId]);
  });

  it("reports both failures, naming the container left behind, when it cannot be removed", async () => {
    const { docker } = createDockerWhoseRunLeavesAContainer({ removalFails: true });
    const provider = new DockerSandboxProvider(settings, docker);

    const creation = provider.create({ threadId: "half-created", supervisorEnvironment: {} });

    await expect(creation).rejects.toThrow(SandboxRefusedError);
    await expect(creation).rejects.toThrow(
      /Minimum memory limit.*undoing it failed too \(.*docker said "Cannot connect to the Docker daemon"\), so container "barrack-thread-half-created" is left behind/,
    );
  });

  it("never acts on a container that is not one of Barrack's sandboxes", async () => {
    const { docker, commands } = createScriptedDocker();
    const provider = new DockerSandboxProvider(settings, docker);

    await expect(provider.stop(otherContainerId)).rejects.toThrow(SandboxNotFoundError);
    await provider.destroy(otherContainerId);
    expect(await provider.getStatus(otherContainerId)).toEqual({ state: "missing" });

    const changingCommands = commands.filter(({ commandArguments }) =>
      ["stop", "rm", "start"].includes(commandArguments[1] ?? ""),
    );
    expect(changingCommands).toEqual([]);
  });

  it("treats a container name or short ID as unknown, because only full IDs identify sandboxes", async () => {
    const { docker, commands } = createScriptedDocker();
    const provider = new DockerSandboxProvider(settings, docker);

    expect(await provider.getStatus("barrack-thread-taken")).toEqual({ state: "missing" });
    expect(await provider.getStatus(barrackContainerId.slice(0, 12))).toEqual({
      state: "missing",
    });
    expect(commands).toEqual([]);
  });

  it("gives the loopback address of a configured service port, and refuses other ports", async () => {
    const provider = new DockerSandboxProvider(settings, createScriptedDocker().docker);

    const address = await provider.getServiceAddress({
      sandboxId: barrackContainerId,
      port: 6080,
      validForSeconds: 60,
    });
    const otherPort = provider.getServiceAddress({
      sandboxId: barrackContainerId,
      port: 22,
      validForSeconds: 60,
    });

    expect(address).toEqual({
      url: "http://127.0.0.1:49153/",
      expiresAt: undefined,
      reachableBy: "the-sandbox-host-only",
    });
    await expect(otherPort).rejects.toThrow(SandboxRefusedError);
  });
});
