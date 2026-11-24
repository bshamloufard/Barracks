import { describe, expect, it } from "vitest";
import {
  SandboxAlreadyExistsError,
  SandboxNotFoundError,
  SandboxRefusedError,
} from "../sandbox-provider-errors.js";
import { DockerCommandFailure, type DockerCommandOptions } from "./docker-cli.js";
import type { DockerProviderSettings } from "./docker-create-arguments.js";
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
    if (subcommand === "create" && commandArguments.includes("barrack-thread-taken")) {
      throw new DockerCommandFailure(
        "exited-with-error",
        `Conflict. The container name "/barrack-thread-taken" is already in use by container "${barrackContainerId}".`,
      );
    }
    if (subcommand === "create") {
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
    if (subcommand === "create") {
      return `${leftoverId}\n`;
    }
    if (subcommand === "start") {
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
  it("creates the container, puts the secrets in it through standard input, and only then starts it", async () => {
    const { docker, commands } = createScriptedDocker();
    const provider = new DockerSandboxProvider(settings, docker);

    const { sandboxId } = await provider.create({
      threadId: "thread-1",
      supervisorEnvironment: { BARRACK_THREAD_ID: "thread-1" },
      supervisorSecrets: { BARRACK_SUPERVISOR_TOKEN: "secret-value" },
    });

    const steps = commands.map(({ commandArguments }) => commandArguments.slice(0, 2).join(" "));
    const create = commands.find(({ commandArguments }) => commandArguments[1] === "create");
    const copy = commands.find(({ commandArguments }) => commandArguments[1] === "cp");
    expect(sandboxId).toBe("d".repeat(64));
    expect(steps).toEqual(["container create", "container cp", "container start"]);
    expect(create?.options.extraEnvironment).toEqual({
      BARRACK_THREAD_ID: "thread-1",
      BARRACK_SUPERVISOR_SECRETS_DIRECTORY: "/var/lib/barrack/secrets",
    });
    expect(copy?.commandArguments).toEqual([
      "container",
      "cp",
      "-",
      `${"d".repeat(64)}:/var/lib/barrack/secrets`,
    ]);
    expect(String(copy?.options.standardInput)).toContain("secret-value");
    expect(JSON.stringify(commands.map(({ commandArguments }) => commandArguments))).not.toContain(
      "secret-value",
    );
  });

  it("replaces the secrets of an existing container before starting it, when asked", async () => {
    const { docker, commands } = createScriptedDocker();
    const provider = new DockerSandboxProvider(settings, docker);

    await provider.start(barrackContainerId);
    await provider.start(barrackContainerId, {
      replacementSecrets: { BARRACK_SUPERVISOR_TOKEN: "newer" },
    });

    const steps = commands
      .map(({ commandArguments }) => commandArguments[1])
      .filter((step) => step !== "inspect");
    expect(steps).toEqual(["start", "cp", "start"]);
  });

  it("refuses environment variable names that would reconfigure the docker command", async () => {
    const provider = new DockerSandboxProvider(settings, createScriptedDocker().docker);

    const creation = provider.create({
      threadId: "thread-1",
      supervisorEnvironment: { DOCKER_HOST: "tcp://elsewhere:2375" },
      supervisorSecrets: {},
    });

    await expect(creation).rejects.toThrow(SandboxRefusedError);
  });

  it("reports the thread's existing sandbox when its container name is taken", async () => {
    const provider = new DockerSandboxProvider(settings, createScriptedDocker().docker);

    const creation = provider.create({
      threadId: "taken",
      supervisorEnvironment: {},
      supervisorSecrets: {},
    });

    await expect(creation).rejects.toThrow(SandboxAlreadyExistsError);
    await expect(creation).rejects.toMatchObject({ existingSandboxId: barrackContainerId });
  });

  it("removes the container a creation that could not start left behind, and reports why", async () => {
    const { docker, commands } = createDockerWhoseRunLeavesAContainer({ removalFails: false });
    const provider = new DockerSandboxProvider(settings, docker);

    const creation = provider.create({
      threadId: "half-created",
      supervisorEnvironment: {},
      supervisorSecrets: {},
    });

    await expect(creation).rejects.toThrow(SandboxRefusedError);
    await expect(creation).rejects.toThrow(/Minimum memory limit/);
    expect(commands.at(-1)).toEqual(["container", "rm", "--force", "--volumes", leftoverId]);
  });

  it("reports both failures, naming the container left behind, when it cannot be removed", async () => {
    const { docker } = createDockerWhoseRunLeavesAContainer({ removalFails: true });
    const provider = new DockerSandboxProvider(settings, docker);

    const creation = provider.create({
      threadId: "half-created",
      supervisorEnvironment: {},
      supervisorSecrets: {},
    });

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
