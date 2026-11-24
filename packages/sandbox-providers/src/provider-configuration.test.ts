import { describe, expect, it } from "vitest";
import { createSandboxProvider } from "./create-sandbox-provider.js";
import { DaytonaSandboxProvider } from "./daytona/daytona-sandbox-provider.js";
import { DockerSandboxProvider } from "./docker/docker-sandbox-provider.js";
import { FakeSandboxProvider } from "./fake/fake-sandbox-provider.js";
import { LocalProcessSandboxProvider } from "./local-process/local-process-sandbox-provider.js";
import { readSandboxProviderConfiguration } from "./provider-configuration.js";

describe("choosing the sandbox provider from the environment", () => {
  it("requires the provider to be named", () => {
    expect(readSandboxProviderConfiguration({})).toEqual({
      ok: false,
      problems: [
        'BARRACK_SANDBOX_PROVIDER: must be one of "fake", "docker", "daytona", "local-process"',
      ],
    });
  });

  it("refuses the local-process provider unless development use is declared in so many words", () => {
    const settings = {
      BARRACK_SANDBOX_PROVIDER: "local-process",
      BARRACK_LOCAL_SANDBOX_DIRECTORY: "/tmp/barrack-sandboxes",
      BARRACK_LOCAL_SUPERVISOR_COMMAND: '["node", "supervisor.js"]',
    };

    for (const acknowledgement of [undefined, "1", "true", "yes"]) {
      const result = readSandboxProviderConfiguration({
        ...settings,
        BARRACK_ALLOW_UNISOLATED_SANDBOXES: acknowledgement,
      });
      expect(result).toEqual({
        ok: false,
        problems: [expect.stringMatching(/^BARRACK_ALLOW_UNISOLATED_SANDBOXES: must be/)],
      });
    }
  });

  it("reads the local-process provider's settings once development use is declared", () => {
    const result = readSandboxProviderConfiguration({
      BARRACK_SANDBOX_PROVIDER: "local-process",
      BARRACK_ALLOW_UNISOLATED_SANDBOXES: "development-only",
      BARRACK_LOCAL_SANDBOX_DIRECTORY: "/tmp/barrack-sandboxes",
      BARRACK_LOCAL_SUPERVISOR_COMMAND: '["node", "--import", "tsx", "supervisor.ts"]',
    });

    expect(result).toEqual({
      ok: true,
      configuration: {
        kind: "local-process",
        localProcess: {
          supervisorCommand: ["node", "--import", "tsx", "supervisor.ts"],
          sandboxesDirectory: "/tmp/barrack-sandboxes",
          stopTimeoutInMilliseconds: 15_000,
        },
      },
    });
  });

  it("refuses a local supervisor command that is not a JSON array of strings, and a relative directory", () => {
    const result = readSandboxProviderConfiguration({
      BARRACK_SANDBOX_PROVIDER: "local-process",
      BARRACK_ALLOW_UNISOLATED_SANDBOXES: "development-only",
      BARRACK_LOCAL_SANDBOX_DIRECTORY: "relative/sandboxes",
      BARRACK_LOCAL_SUPERVISOR_COMMAND: "node supervisor.js",
    });

    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems.map((problem) => problem.split(":")[0])).toEqual([
      "BARRACK_LOCAL_SANDBOX_DIRECTORY",
      "BARRACK_LOCAL_SUPERVISOR_COMMAND",
    ]);
  });

  it("reads Docker's settings, with defaults for the limits", () => {
    const result = readSandboxProviderConfiguration({
      BARRACK_SANDBOX_PROVIDER: "docker",
      BARRACK_DOCKER_IMAGE: "barrack-sandbox:dev",
      BARRACK_DOCKER_SERVICE_PORTS: "6080, 5900",
    });

    expect(result).toEqual({
      ok: true,
      configuration: {
        kind: "docker",
        docker: {
          image: "barrack-sandbox:dev",
          cpuLimit: 2,
          memoryLimitInMebibytes: 4096,
          processLimit: 1024,
          stopTimeoutInSeconds: 15,
          servicePorts: [6080, 5900],
          dockerExecutable: "docker",
        },
      },
    });
  });

  it("lists every missing Daytona setting without echoing any value", () => {
    const result = readSandboxProviderConfiguration({
      BARRACK_SANDBOX_PROVIDER: "daytona",
      BARRACK_DAYTONA_AUTO_ARCHIVE_MINUTES: "not-a-number-secret",
    });

    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems.map((problem) => problem.split(":")[0])).toEqual([
      "DAYTONA_API_KEY",
      "BARRACK_DAYTONA_SNAPSHOT",
      "BARRACK_DAYTONA_AUTO_ARCHIVE_MINUTES",
    ]);
    expect(problems.join(" ")).not.toContain("not-a-number-secret");
  });

  it("builds the configured provider", () => {
    expect(createSandboxProvider({ kind: "fake" })).toBeInstanceOf(FakeSandboxProvider);
    const docker = readSandboxProviderConfiguration({
      BARRACK_SANDBOX_PROVIDER: "docker",
      BARRACK_DOCKER_IMAGE: "barrack-sandbox:dev",
    });
    const daytona = readSandboxProviderConfiguration({
      BARRACK_SANDBOX_PROVIDER: "daytona",
      DAYTONA_API_KEY: "not-a-real-key",
      BARRACK_DAYTONA_SNAPSHOT: "barrack-sandbox-1",
    });
    expect(docker.ok && createSandboxProvider(docker.configuration)).toBeInstanceOf(
      DockerSandboxProvider,
    );
    expect(daytona.ok && createSandboxProvider(daytona.configuration)).toBeInstanceOf(
      DaytonaSandboxProvider,
    );
    expect(
      createSandboxProvider({
        kind: "local-process",
        localProcess: {
          supervisorCommand: ["node"],
          sandboxesDirectory: "/tmp/barrack-sandboxes",
          stopTimeoutInMilliseconds: 1000,
        },
      }),
    ).toBeInstanceOf(LocalProcessSandboxProvider);
  });
});
