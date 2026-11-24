import { describe, expect, it } from "vitest";
import { readConfiguration } from "./configuration.js";

const validToken = "a".repeat(32);

describe("the control plane configuration", () => {
  it("listens on the loopback interface, port 8787, when only the token is given", () => {
    const result = readConfiguration({ BARRACK_SUPERVISOR_TOKEN: validToken });

    expect(result).toEqual({
      ok: true,
      configuration: {
        supervisorToken: validToken,
        host: "127.0.0.1",
        port: 8787,
        allowedClientOrigins: [
          "http://localhost:5173",
          "http://127.0.0.1:5173",
          "http://localhost:8787",
          "http://127.0.0.1:8787",
        ],
        webClientDirectory: undefined,
        logLevel: "info",
      },
    });
  });

  it("refuses to start without a supervisor token", () => {
    const result = readConfiguration({});

    expect(result).toEqual({
      ok: false,
      problems: [expect.stringMatching(/^BARRACK_SUPERVISOR_TOKEN: required/)],
    });
  });

  it("reports every problem at once", () => {
    const result = readConfiguration({
      BARRACK_SUPERVISOR_TOKEN: "short",
      BARRACK_CONTROL_PLANE_PORT: "not-a-port",
      BARRACK_ALLOWED_CLIENT_ORIGINS: "not a url",
      BARRACK_WEB_CLIENT_DIRECTORY: "/no/such/directory",
      BARRACK_LOG_LEVEL: "loud",
    });

    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems;
    expect(problems.map((problem) => problem.split(/[.:]/)[0])).toEqual([
      "BARRACK_SUPERVISOR_TOKEN",
      "BARRACK_CONTROL_PLANE_PORT",
      "BARRACK_ALLOWED_CLIENT_ORIGINS",
      "BARRACK_WEB_CLIENT_DIRECTORY",
      "BARRACK_LOG_LEVEL",
    ]);
  });

  it("never repeats the supervisor token in a problem", () => {
    const shortSecret = "secret-but-short";

    const result = readConfiguration({ BARRACK_SUPERVISOR_TOKEN: shortSecret });

    expect(JSON.stringify(result)).not.toContain(shortSecret);
  });

  it("compares allowed origins the way browsers send them", () => {
    const result = readConfiguration({
      BARRACK_SUPERVISOR_TOKEN: validToken,
      BARRACK_ALLOWED_CLIENT_ORIGINS: "https://barrack.example/ , http://localhost:3000",
    });

    expect(result.ok && result.configuration.allowedClientOrigins).toEqual([
      "https://barrack.example",
      "http://localhost:3000",
    ]);
  });
});
