import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { defaultGitChildLimits, findApplicableLimits } from "./git-child-limits.js";
import { IsolatedGitRepository } from "./isolated-git-repository.js";

/**
 * Where the isolated repository's Git sends the write token: to the
 * remote's own URL when it asks for one, and nowhere else, not even where
 * that remote redirects.
 */

const token = "ghs_write-token-for-one-repository";
const servers: Server[] = [];
const repositories: IsolatedGitRepository[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    await repository.discard();
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

type SeenRequest = { url: string; authorization: string | undefined };

/** A server answering every request with `answer`, recording what it was sent. */
async function startServer(
  answer: (request: IncomingMessage) => { status: number; headers: Record<string, string> },
): Promise<{ baseUrl: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url ?? "", authorization: request.headers.authorization });
    const { status, headers } = answer(request);
    response.writeHead(status, headers);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, seen };
}

const askForCredentials = () => ({
  status: 401,
  headers: { "WWW-Authenticate": 'Basic realm="GitHub"' },
});

async function isolatedRepositoryFor(remoteUrl: string): Promise<IsolatedGitRepository> {
  const repository = await IsolatedGitRepository.create({
    remoteUrl,
    credentials: { username: "x-access-token", password: token },
    allowPlainHttp: true,
    limits: defaultGitChildLimits,
    applicableLimits: findApplicableLimits(),
    signal: new AbortController().signal,
  });
  repositories.push(repository);
  return repository;
}

function basicAuthorizationCarrying(password: string): string {
  return `Basic ${Buffer.from(`x-access-token:${password}`).toString("base64")}`;
}

describe("the write token", () => {
  it("is offered to the remote that asks for it", async () => {
    const remote = await startServer(askForCredentials);
    const repository = await isolatedRepositoryFor(`${remote.baseUrl}/octo/app.git`);

    await expect(repository.fetchBaseBranch("main")).rejects.toThrow();

    expect(remote.seen.map((request) => request.authorization)).toContain(
      basicAuthorizationCarrying(token),
    );
  });

  it("is never sent where the remote redirects, nor is the redirect followed", async () => {
    const elsewhere = await startServer(askForCredentials);
    const remote = await startServer((request) => ({
      status: 302,
      headers: { Location: `${elsewhere.baseUrl}${request.url ?? "/"}` },
    }));
    const repository = await isolatedRepositoryFor(`${remote.baseUrl}/octo/app.git`);

    await expect(repository.fetchBaseBranch("main")).rejects.toThrow();

    expect(remote.seen.length).toBeGreaterThan(0);
    expect(elsewhere.seen).toEqual([]);
  });
});
