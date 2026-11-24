import type { ModelCredential } from "@barrack/protocol";
import { describe, expect, it } from "vitest";
import type { ModelAccess } from "../agent-harness.js";
import { isPiOutOfStep, type PiRunningOn, planPiCredentials } from "./pi-credential-plan.js";

const key = (secret: string): ModelCredential => ({ kind: "api_key", secret, settings: {} });
const token = (secret: string, baseUrl = "http://control-plane/threads/t/model-proxy/anthropic") =>
  ({ kind: "proxy_token", secret, baseUrl }) satisfies ModelCredential;

const access = (model: string, credential: ModelCredential | null): ModelAccess => ({
  model,
  credential,
});

const runningOnMock: PiRunningOn = { model: "mock/mock-1", credential: key("mock-key-0001") };

describe("what Pi's credential files hold", () => {
  it("is the thread's model's credential alone between runs", () => {
    const plan = planPiCredentials(
      access("backup/backup-1", key("backup-key-02")),
      runningOnMock,
      false,
    );

    expect([...plan]).toEqual([["backup", key("backup-key-02")]]);
  });

  it("keeps the run in progress's own provider beside the new model's after a switch", () => {
    const plan = planPiCredentials(
      access("anthropic/a-model", token("proxy-token-03")),
      runningOnMock,
      true,
    );

    expect(Object.fromEntries(plan)).toEqual({
      mock: key("mock-key-0001"),
      anthropic: token("proxy-token-03"),
    });
  });

  it("replaces the running provider's key at once, and erases a removed one at once", () => {
    expect(
      Object.fromEntries(
        planPiCredentials(access("mock/mock-1", key("mock-key-0002")), runningOnMock, true),
      ),
    ).toEqual({ mock: key("mock-key-0002") });
    expect(planPiCredentials(access("mock/mock-1", null), runningOnMock, true).size).toBe(0);
  });

  it("keeps a key the running Pi could not swap for a proxy token until the run ends", () => {
    const plan = planPiCredentials(
      access("mock/mock-1", token("proxy-token-04")),
      runningOnMock,
      true,
    );

    expect(Object.fromEntries(plan)).toEqual({ mock: key("mock-key-0001") });
    expect(isPiOutOfStep(access("mock/mock-1", token("proxy-token-04")), runningOnMock)).toBe(true);
  });

  it("asks for Pi to start again only for another model or another address", () => {
    expect(isPiOutOfStep(access("mock/mock-1", key("mock-key-0009")), runningOnMock)).toBe(false);
    expect(isPiOutOfStep(access("mock/mock-2", key("mock-key-0001")), runningOnMock)).toBe(true);
    expect(isPiOutOfStep(access("mock/mock-1", null), runningOnMock)).toBe(true);
    expect(isPiOutOfStep(access("mock/mock-1", null), undefined)).toBe(false);
  });
});
