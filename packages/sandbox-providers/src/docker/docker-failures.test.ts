import { describe, expect, it } from "vitest";
import {
  SandboxNotFoundError,
  SandboxProviderUnavailableError,
  SandboxRefusedError,
} from "../sandbox-provider-errors.js";
import { DockerCommandFailure } from "./docker-cli.js";
import { isContainerNameConflict, toSandboxProviderError } from "./docker-failures.js";

function exitedWith(standardError: string): DockerCommandFailure {
  return new DockerCommandFailure("exited-with-error", standardError);
}

describe("classifying a failed docker command", () => {
  it("reports a missing container as not found", () => {
    const error = toSandboxProviderError(
      exitedWith("Error response from daemon: No such container: abc"),
      "start sandbox",
      "abc",
    );

    expect(error).toBeInstanceOf(SandboxNotFoundError);
  });

  it("reports an unreachable daemon or a missing docker command as unavailable", () => {
    const unreachable = exitedWith(
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    );

    expect(toSandboxProviderError(unreachable, "create")).toBeInstanceOf(
      SandboxProviderUnavailableError,
    );
    expect(
      toSandboxProviderError(new DockerCommandFailure("not-installed", ""), "create"),
    ).toBeInstanceOf(SandboxProviderUnavailableError);
    expect(
      toSandboxProviderError(new DockerCommandFailure("timed-out", ""), "create"),
    ).toBeInstanceOf(SandboxProviderUnavailableError);
  });

  it("reports an image that cannot be found as a refusal, quoting docker", () => {
    const error = toSandboxProviderError(
      exitedWith("Unable to find image 'barrack-sandbox:missing' locally\nmore detail"),
      "create a sandbox",
    );

    expect(error).toBeInstanceOf(SandboxRefusedError);
    expect(error.message).toBe(
      `Could not create a sandbox: docker said "Unable to find image 'barrack-sandbox:missing' locally"`,
    );
  });

  it("reports anything it does not recognise as unavailable, so the caller may retry", () => {
    expect(toSandboxProviderError(exitedWith("something new"), "stop")).toBeInstanceOf(
      SandboxProviderUnavailableError,
    );
  });

  it("recognises a container name that is already taken", () => {
    expect(
      isContainerNameConflict(
        exitedWith(
          'docker: Error response from daemon: Conflict. The container name "/barrack-thread-a" is already in use by container "123".',
        ),
      ),
    ).toBe(true);
  });
});
