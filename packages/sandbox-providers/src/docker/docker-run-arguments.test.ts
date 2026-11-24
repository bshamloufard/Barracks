import { describe, expect, it } from "vitest";
import { buildRunArguments, type DockerProviderSettings } from "./docker-run-arguments.js";

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
  supervisorEnvironment: {
    BARRACK_SUPERVISOR_TOKEN: "do-not-show-this",
    BARRACK_CONTROL_PLANE_URL: "ws://host.docker.internal:8787",
  },
};

describe("the docker run arguments for a thread's sandbox", () => {
  it("names the environment variables without their values, which never reach the process list", () => {
    const runArguments = buildRunArguments(settings, request);

    expect(runArguments.join(" ")).not.toContain("do-not-show-this");
    expect(runArguments).toContain("BARRACK_SUPERVISOR_TOKEN");
    expect(runArguments).toContain("BARRACK_CONTROL_PLANE_URL");
  });

  it("names and labels the container after its thread, and ends with the image", () => {
    const runArguments = buildRunArguments(settings, request);

    expect(runArguments.slice(0, 8)).toEqual([
      "run",
      "--detach",
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
    const runArguments = buildRunArguments(settings, request).join(" ");

    expect(runArguments).toContain("--add-host host.docker.internal:host-gateway");
    expect(runArguments).toContain("--cpus 2 --memory 4096m --memory-swap 4096m");
    expect(runArguments).toContain("--pids-limit 1024 --stop-timeout 15");
    expect(runArguments).toContain("--cap-drop ALL --cap-add SETUID --cap-add SETGID");
    expect(runArguments).not.toContain("--privileged");
  });

  it("leaves the sandbox on Docker's default bridge unless a network is configured", () => {
    expect(buildRunArguments(settings, request)).not.toContain("--network");
    expect(
      buildRunArguments({ ...settings, network: "barrack-sandboxes" }, request).join(" "),
    ).toContain("--network barrack-sandboxes");
  });

  it("publishes no ports unless service ports are configured, and then only on loopback", () => {
    expect(buildRunArguments(settings, request)).not.toContain("--publish");
    expect(buildRunArguments({ ...settings, servicePorts: [6080] }, request).join(" ")).toContain(
      "--publish 127.0.0.1::6080",
    );
  });
});
