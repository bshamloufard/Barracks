import { createServer, type Server, type ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { TestIdentityIssuer } from "@barrack/test-identity-issuer";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { requireAsymmetricSigningKeys } from "./signing-key-check.js";
import type { SupabaseProject } from "./supabase-project.js";

const quickRetries = { firstDelayInMilliseconds: 5, longestDelayInMilliseconds: 20 };

const publishedKeySet = { keys: [{ kty: "EC", crv: "P-256", kid: "key-1", x: "x", y: "y" }] };

type ScriptedAnswer = (response: ServerResponse) => void;

const answers = {
  dropConnection: (response: ServerResponse) => response.socket?.destroy(),
  status: (statusCode: number) => (response: ServerResponse) =>
    response.writeHead(statusCode).end("unavailable"),
  keySet: (response: ServerResponse) =>
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(publishedKeySet)),
};

const serversToClose: Server[] = [];

afterEach(async () => {
  await Promise.all(
    serversToClose.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** A stand-in for Supabase that answers each key set request with the next scripted answer. */
async function startScriptedSupabase(script: ScriptedAnswer[]): Promise<SupabaseProject> {
  const server = createServer((_request, response) => {
    const answer = script.length > 1 ? script.shift() : script[0];
    answer?.(response);
  });
  serversToClose.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The scripted Supabase has no TCP address.");
  }
  const url = `http://127.0.0.1:${address.port}`;
  return { url, publishableKey: "sb_publishable_test", issuer: `${url}/auth/v1` };
}

/** The fields of a logged retry the tests look at. */
type RetryLogLine = {
  msg: string;
  attempt: number;
  retryDelayInMilliseconds: number;
  reason: string;
};

/** A logger whose JSON lines the test can read. */
function createRecordingLogger() {
  const lines: RetryLogLine[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return { logger: pino({ level: "info" }, destination), lines };
}

describe("checking a Supabase project's signing keys at startup", () => {
  it("passes when the project publishes a public signing key", async () => {
    const issuer = await TestIdentityIssuer.start();
    const project = { url: issuer.supabaseUrl, publishableKey: "key", issuer: issuer.issuer };

    await expect(
      requireAsymmetricSigningKeys(project, createRecordingLogger().logger),
    ).resolves.toBeUndefined();
    await issuer.close();
  });

  it("fails at once, telling the owner to rotate, when the project publishes no public key (it still uses the legacy shared secret)", async () => {
    const legacyIssuer = await TestIdentityIssuer.start({ publishInitialKey: false });
    const project = {
      url: legacyIssuer.supabaseUrl,
      publishableKey: "key",
      issuer: legacyIssuer.issuer,
    };

    const check = requireAsymmetricSigningKeys(project, createRecordingLogger().logger);

    await expect(check).rejects.toThrow(
      /legacy shared secret.*rotate to an asymmetric signing key/,
    );
    expect(legacyIssuer.keySetRequestCount).toBe(1);
    await legacyIssuer.close();
  });

  it("keeps trying while Supabase cannot be reached or fails, logging each attempt, and passes once it answers", async () => {
    const project = await startScriptedSupabase([
      answers.dropConnection,
      answers.status(503),
      answers.keySet,
    ]);
    const { logger, lines } = createRecordingLogger();

    await requireAsymmetricSigningKeys(project, logger, quickRetries);

    expect(lines.map((line) => [line.attempt, line.retryDelayInMilliseconds])).toEqual([
      [1, 5],
      [2, 10],
    ]);
    expect(lines[0]?.reason).toMatch(/^fetch failed/);
    expect(lines[1]?.reason).toBe("HTTP 503 without a key set");
    expect(lines[0]?.msg).toMatch(/trying again.*check BARRACK_SUPABASE_URL/);
  });

  it("keeps trying, rather than exiting, while the address answers with something that is not a key set", async () => {
    const project = await startScriptedSupabase([
      answers.status(404),
      answers.status(404),
      answers.status(404),
      answers.status(404),
      answers.keySet,
    ]);
    const { logger, lines } = createRecordingLogger();

    await requireAsymmetricSigningKeys(project, logger, quickRetries);

    expect(lines.map((line) => line.retryDelayInMilliseconds)).toEqual([5, 10, 20, 20]);
    expect(lines.every((line) => line.reason === "HTTP 404 without a key set")).toBe(true);
  });
});
