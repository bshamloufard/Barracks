import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { afterEach, describe, expect, it } from "vitest";
import { TestControlPlane } from "../test-support/test-control-plane.js";

/**
 * The browser security headers, as the control plane sends them with the
 * built web client and with the API. Whether the real built client runs
 * under the policy is shown in a browser by the end-to-end test
 * `web-client-security-policy.test.ts`.
 */

const temporaryDirectories: string[] = [];
let controlPlane: TestControlPlane | undefined;
let issuer: TestIdentityIssuer | undefined;

afterEach(async () => {
  await controlPlane?.close();
  await issuer?.close();
  controlPlane = undefined;
  issuer = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function webClientDirectoryWithAnAsset(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "barrack-web-client-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Barrack</title>");
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "assets", "index-abc123.js"), "console.log('Barrack');");
  return directory;
}

/** A control plane signing users in with a stand-in Supabase project, serving the web client. */
async function startWithSupabase(): Promise<TestControlPlane> {
  issuer = await TestIdentityIssuer.start();
  return TestControlPlane.start({
    authentication: { kind: "test-issuer", issuer },
    webClientDirectory: await webClientDirectoryWithAnAsset(),
  });
}

type Answer = { status: number; headers: Record<string, string | string[] | undefined> };

/** A GET with headers of the test's choosing, `Host` included, which `fetch` will not send. */
function get(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  if (controlPlane === undefined) {
    throw new Error("Start the control plane first.");
  }
  const url = new URL(path, controlPlane.httpBaseUrl);
  return new Promise((resolve, reject) => {
    request(url, { headers }, (response) => {
      response.resume();
      response.once("end", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers }),
      );
    })
      .once("error", reject)
      .end();
  });
}

function directivesOf(answer: Answer): Map<string, string> {
  const policy = String(answer.headers["content-security-policy"]);
  return new Map(
    policy.split(";").map((directive) => {
      const [name = "", ...sources] = directive.trim().split(/\s+/);
      return [name, sources.join(" ")];
    }),
  );
}

describe("the browser security headers", () => {
  it("give the web client's page a policy allowing only its own files, its origin and Supabase", async () => {
    controlPlane = await startWithSupabase();

    const answer = await get("/");

    expect(answer.status).toBe(200);
    expect(Object.fromEntries(directivesOf(answer))).toEqual({
      "default-src": "'none'",
      "script-src": "'self'",
      "style-src": "'self'",
      "img-src": "'self' data:",
      "connect-src": `'self' ws://localhost:5173 ${issuer?.supabaseUrl}`,
      "base-uri": "'none'",
      "form-action": "'self'",
      "frame-ancestors": "'none'",
    });
    expect(answer.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
    });
  });

  it("give the web client's assets and the GitHub callback page the same policy as the page", async () => {
    controlPlane = await startWithSupabase();
    const page = await get("/");

    const asset = await get("/assets/index-abc123.js");
    const githubCallback = await get("/github/callback?code=abc&state=def");

    expect(asset.status).toBe(200);
    expect(asset.headers["content-security-policy"]).toBe(page.headers["content-security-policy"]);
    expect(asset.headers["x-content-type-options"]).toBe("nosniff");
    expect(githubCallback.headers["content-security-policy"]).toBe(
      page.headers["content-security-policy"],
    );
  });

  it("give API answers and the health check a policy that lets nothing load", async () => {
    controlPlane = await startWithSupabase();

    for (const path of ["/api/client-configuration", "/api/threads", "/health"]) {
      const answer = await get(path);

      expect(answer.headers).toMatchObject({
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "same-origin",
      });
    }
  });

  it("allow no Supabase origin in development mode, which signs nobody in", async () => {
    controlPlane = await TestControlPlane.start({
      webClientDirectory: await webClientDirectoryWithAnAsset(),
    });

    const answer = await get("/");

    expect(directivesOf(answer).get("connect-src")).toBe("'self' ws://localhost:5173");
  });

  it("ask for HTTPS from now on only when a proxy says the browser came over HTTPS", async () => {
    controlPlane = await startWithSupabase();
    const publicHost = { Host: "barrack.example.com" };

    const overHttps = await get("/", { ...publicHost, "X-Forwarded-Proto": "https" });
    const apiOverHttps = await get("/api/threads", { ...publicHost, "X-Forwarded-Proto": "https" });
    const overHttp = await get("/", publicHost);
    const forwardedOverHttp = await get("/", { ...publicHost, "X-Forwarded-Proto": "http" });
    const healthCheck = await get("/health", { Host: "healthcheck.railway.app" });

    expect(overHttps.headers["strict-transport-security"]).toBe("max-age=31536000");
    expect(apiOverHttps.headers["strict-transport-security"]).toBe("max-age=31536000");
    expect(overHttp.headers["strict-transport-security"]).toBeUndefined();
    expect(forwardedOverHttp.headers["strict-transport-security"]).toBeUndefined();
    expect(healthCheck.headers["strict-transport-security"]).toBeUndefined();
  });

  it("never ask a browser to use HTTPS for a loopback name, even through an HTTPS proxy", async () => {
    controlPlane = await startWithSupabase();

    for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787"]) {
      const answer = await get("/", { Host: host, "X-Forwarded-Proto": "https" });

      expect(answer.headers["strict-transport-security"]).toBeUndefined();
    }
  });

  it("are sent with development mode's refusal of a host other than loopback", async () => {
    controlPlane = await TestControlPlane.start({
      webClientDirectory: await webClientDirectoryWithAnAsset(),
    });

    const answer = await get("/", { Host: "rebound.example.com" });

    expect(answer.status).toBe(403);
    expect(answer.headers).toMatchObject({
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    });
  });
});
