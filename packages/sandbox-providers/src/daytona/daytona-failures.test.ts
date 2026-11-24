import { describe, expect, it } from "vitest";
import {
  SandboxImageUnavailableError,
  SandboxNotFoundError,
  SandboxProviderUnavailableError,
  SandboxRefusedError,
} from "../sandbox-provider-errors.js";
import { DaytonaApiFailure } from "./daytona-api.js";
import { toSandboxProviderError } from "./daytona-failures.js";

function answeredWith(statusCode: number): DaytonaApiFailure {
  return new DaytonaApiFailure(`HTTP ${statusCode}`, statusCode, false);
}

describe("classifying a failed Daytona call", () => {
  it("reports 404 for a named sandbox as not found", () => {
    expect(toSandboxProviderError(answeredWith(404), "start", "daytona-1")).toBeInstanceOf(
      SandboxNotFoundError,
    );
  });

  it("reports connection failures, timeouts, rate limits and server errors as unavailable", () => {
    const failures = [
      new DaytonaApiFailure("socket hang up", undefined, true),
      answeredWith(408),
      answeredWith(429),
      answeredWith(500),
      answeredWith(503),
    ];
    for (const failure of failures) {
      expect(toSandboxProviderError(failure, "create")).toBeInstanceOf(
        SandboxProviderUnavailableError,
      );
    }
  });

  it("reports other client errors, such as a rejected key or an exhausted quota, as refusals", () => {
    for (const statusCode of [400, 401, 403, 409, 422]) {
      expect(toSandboxProviderError(answeredWith(statusCode), "create")).toBeInstanceOf(
        SandboxRefusedError,
      );
    }
  });

  it("reports 404 during creation, a missing snapshot, as a refusal", () => {
    expect(toSandboxProviderError(answeredWith(404), "create")).toBeInstanceOf(SandboxRefusedError);
  });

  it("reports a snapshot Daytona cannot use as an image the administrator must provide", () => {
    const error = toSandboxProviderError(
      new DaytonaApiFailure("Snapshot barrack-sandbox-7 not found", 400, false),
      "create a sandbox",
    );

    expect(error).toBeInstanceOf(SandboxImageUnavailableError);
    expect(error.message).toMatch(/BARRACK_DAYTONA_SNAPSHOT cannot be used/);
  });

  it("quotes Daytona's message and keeps nothing else of the failure", () => {
    const error = toSandboxProviderError(
      new DaytonaApiFailure("Total CPU quota exceeded", 403, false),
      "create a sandbox",
    );

    expect(error.message).toBe(
      'Could not create a sandbox: Daytona said "Total CPU quota exceeded"',
    );
    expect(error.cause).toBeUndefined();
  });
});
