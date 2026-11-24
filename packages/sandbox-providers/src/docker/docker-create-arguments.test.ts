import { describe, expect, it } from "vitest";
import {
  buildContainerEnvironment,
  buildCreateArguments,
  type DockerProviderSettings,
} from "./docker-create-arguments.js";

const settings: DockerProviderSettings = {
  image: "barrack-sandbox:dev",
  cpuLimit: 2,
  memoryLimitInMebibytes: 4096,
  processLimit: 1024,
  stopTimeoutInSeconds: 15,
  servicePorts: [],
  dockerExecutable: "docker",
  network: undefined,
};

const request = {
  threadId: "thread-1",
  supervisorEnvironment: { BARRACK_CONTROL_PLANE_URL: "ws://host.docker.internal:8787" },
  supervisorSecrets: { BARRACK_SUPERVISOR_TOKEN: "do-not-show-this" },
};

describe("the docker run arguments for a thread's sandbox", () => {
  it("names the environment variables without their values, which never reach the process list", () => {
    const runArguments = buildCreateArguments(settings, request).join(" ");

    expect(runArguments).toContain("--env BARRACK_CONTROL_PLANE_URL");
    expect(runArguments).toContain("--env BARRACK_SUPERVISOR_SECRETS_DIRECTORY");
    expect(runArguments).not.toContain("ws://");
  });

  it("puts no secret in the container's environment, only where the secrets are", () => {
    const environment = buildContainerEnvironment(request);

    expect(environment).toEqual({
      BARRACK_CONTROL_PLANE_URL: "ws://host.docker.internal:8787",
      BARRACK_SUPERVISOR_SECRETS_DIRECTORY: "/var/lib/barrack/secrets",
    });
    expect(buildCreateArguments(settings, request).join(" ")).not.toContain("TOKEN");
  });

  it("names and labels the container after its thread, and ends with the image", () => {
    const runArguments = buildCreateArguments(settings, request);

    expect(runArguments.slice(0, 8)).toEqual([
      "container",
      "create",
      "--name",
      "barrack-thread-thread-1",
      "--label",
      "barrack.sandbox=true",
      "--label",
      "barrack.thread-id=thread-1",
    ]);
    expect(runArguments.at(-1)).toBe("barrack-sandbox:dev");
  });

  it("limits resources, drops capabilities and lets the supervisor reach the host", () => {
    const runArguments = buildCreateArguments(settings, request).join(" ");

    expect(runArguments).toContain("--add-host host.docker.internal:host-gateway");
    expect(runArguments).toContain("--cpus 2 --memory 4096m --memory-swap 4096m");
    expect(runArguments).toContain("--pids-limit 1024 --stop-timeout 15");
    expect(runArguments).toContain("--cap-drop ALL --cap-add SETUID --cap-add SETGID");
    expect(runArguments).not.toContain("--privileged");
  });

  it("leaves the sandbox on Docker's default bridge unless a network is configured", () => {
    expect(buildCreateArguments(settings, request)).not.toContain("--network");
    expect(
      buildCreateArguments({ ...settings, network: "barrack-sandboxes" }, request).join(" "),
    ).toContain("--network barrack-sandboxes");
  });

  it("publishes no ports unless service ports are configured, and then only on loopback", () => {
    expect(buildCreateArguments(settings, request)).not.toContain("--publish");
    expect(
      buildCreateArguments({ ...settings, servicePorts: [6080] }, request).join(" "),
    ).toContain("--publish 127.0.0.1::6080");
  });
});
