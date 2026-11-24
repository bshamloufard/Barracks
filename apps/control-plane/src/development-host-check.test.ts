import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClientEndpointPath,
  buildPublicationBundleUploadPath,
  buildPublishThreadApiPath,
  buildSupervisorEndpointPath,
  githubCallbackPagePath,
} from "@barrack/protocol";
import { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { afterEach, describe, expect, it } from "vitest";
import { developmentAccessToken } from "./authentication/development-single-user.js";
import { isAddressedToLoopback } from "./loopback-host.js";
import { TestControlPlane } from "./test-support/test-control-plane.js";
import { attemptUpgrade } from "./test-support/test-socket.js";

/**
 * Development mode answers anyone as its one user, so a web page that points
 * its own domain at 127.0.0.1 (DNS rebinding) must be refused although its
 * same-origin GET requests carry no `Origin`. Its `Host` gives it away.
 */

const rebindingHost = "rebind.attacker.example:8787";

let controlPlane: TestControlPlane | undefined;
let issuer: TestIdentityIssuer | undefined;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await controlPlane?.close();
  await issuer?.close();
  controlPlane = undefined;
  issuer = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

/** A request with exactly the headers given; `fetch` would not let a test choose `Host`. */
function getWithHost(
  path: string,
  host: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ statusCode: number; body: string }> {
  const port = new URL(controlPlane?.httpBaseUrl ?? "").port;
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port, path, method, headers: { ...headers, Host: host } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function webClientDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "barrack-web-client-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Barrack</title>");
  return directory;
}

describe("telling a request addressed to loopback from one that is not", () => {
  it.each([
    "localhost",
    "localhost:5173",
    "LOCALHOST:8787",
    "127.0.0.1",
    "127.0.0.1:8787",
    "127.10.20.30:80",
    "[::1]",
    "[::1]:8787",
  ])("takes %s as loopback", (host) => {
    expect(isAddressedToLoopback(host)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "rebind.attacker.example",
    "rebind.attacker.example:8787",
    "localhost.attacker.example",
    "attacker.localhost.example",
    "localhost.",
    "user@localhost",
    "localhost/path",
    "127.1",
    "128.0.0.1",
    "0.0.0.0:8787",
    "[::ffff:127.0.0.1]",
    "[::2]",
    "localhost:8787:1",
  ])("does not take %s as loopback", (host) => {
    expect(isAddressedToLoopback(host)).toBe(false);
  });
});

describe("a control plane in development mode", () => {
  it("refuses every HTTP request addressed to another name, on every path, without quoting it, a supervisor's upload included", async () => {
    controlPlane = await TestControlPlane.start({ webClientDirectory: await webClientDirectory() });
    const authorization = { Authorization: `Bearer ${developmentAccessToken}` };

    const { threadId, supervisorToken } = await controlPlane.createThread();
    const pagesAndApi = [
      "/api/threads",
      "/api/client-configuration",
      "/api/github/connection",
      buildPublishThreadApiPath(threadId),
      "/health",
      "/",
      "/index.html",
      githubCallbackPagePath,
    ];

    const answers = await Promise.all([
      ...pagesAndApi.map((path) => getWithHost(path, rebindingHost, authorization)),
      getWithHost(
        buildPublicationBundleUploadPath(threadId, "publication-1"),
        rebindingHost,
        { Authorization: `Bearer ${supervisorToken}` },
        "PUT",
      ),
    ]);

    for (const answer of answers) {
      expect(answer.statusCode).toBe(403);
      expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "forbidden_host" } });
      expect(answer.body).not.toContain("attacker");
    }
  });

  it("answers requests addressed to localhost, 127.0.0.1 or [::1], with any port", async () => {
    controlPlane = await TestControlPlane.start();
    const authorization = { Authorization: `Bearer ${developmentAccessToken}` };

    const answers = await Promise.all(
      ["localhost:5173", "127.0.0.1:8787", "[::1]:8787", "localhost"].map((host) =>
        getWithHost("/api/threads", host, authorization),
      ),
    );

    expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200, 200, 200]);
  });

  it("refuses a client's WebSocket upgrade addressed to another name", async () => {
    controlPlane = await TestControlPlane.start();
    const { threadId } = await controlPlane.createThread();
    const path = buildClientEndpointPath({ threadId, lastSeenSequence: 0 });

    const outcome = await attemptUpgrade(`${controlPlane.baseUrl}${path}`, { Host: rebindingHost });

    expect(outcome).toMatchObject({ opened: false, statusCode: 403 });
  });

  it("refuses a supervisor's WebSocket upgrade addressed to another name, even with its thread's token", async () => {
    controlPlane = await TestControlPlane.start();
    const { threadId, supervisorToken } = await controlPlane.createThread();
    const path = buildSupervisorEndpointPath({ threadId });

    const outcome = await attemptUpgrade(`${controlPlane.baseUrl}${path}`, {
      Host: rebindingHost,
      Authorization: `Bearer ${supervisorToken}`,
    });

    expect(outcome).toMatchObject({ opened: false, statusCode: 403 });
  });
});

describe("a control plane verifying real access tokens", () => {
  it("answers whatever name it was reached by, since it may sit behind any domain or proxy", async () => {
    issuer = await TestIdentityIssuer.start();
    controlPlane = await TestControlPlane.start({
      authentication: { kind: "test-issuer", issuer },
    });

    const answer = await getWithHost("/api/client-configuration", "barrack.example.com");

    expect(answer.statusCode).toBe(200);
  });
});
