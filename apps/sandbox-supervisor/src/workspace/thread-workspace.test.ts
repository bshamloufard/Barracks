import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeGithub, type FakeRepository } from "@barrack/fake-github";
import type { WorkspaceEvent, WorkspaceRepository } from "@barrack/protocol";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentCommandRequest,
  AgentProcessLauncher,
} from "../agent-process/agent-process-launcher.js";
import { SameUserAgentLauncher } from "../agent-process/same-user-agent-launcher.js";
import type { CredentialAnswer } from "./git-credential-server.js";
import { sendPublicationBundle } from "./publication-bundle.js";
import { describeCredentialHelperCommand, ThreadWorkspace } from "./thread-workspace.js";

/**
 * Preparing the agent's workspace, with Git run through a launcher that
 * records every command, against the fake GitHub: the clone and its
 * failures, the credential helper, a resumed and a recreated sandbox, and
 * the bundle made for publishing. Nothing given out as a credential may be
 * in Git's configuration, a command's arguments or environment, an event or
 * a log line.
 */

const tsxLoader = import.meta.resolve("tsx");
const workBranch = "barrack/thread-1";
const author = { name: "Octo Cat", email: "42+octocat@users.noreply.github.com" };
const { PATH: searchPath } = process.env;

let github: FakeGithub;
let privateRepository: FakeRepository;
let publicRepository: FakeRepository;
let directory: string;
let launches: AgentCommandRequest[];
let events: WorkspaceEvent[];
let logLines: string[];
let grantedTokens: string[];
let credentialAnswer: () => CredentialAnswer;

/** Same-user launches, each recorded with its arguments and environment. */
function recordingLauncher(): AgentProcessLauncher {
  const launcher = new SameUserAgentLauncher();
  return {
    description: "recorded",
    launch: (request) => launcher.launch(request),
    launchCommand: (request) => {
      launches.push(request);
      return launcher.launchCommand(request);
    },
  };
}

function createWorkspace(sandbox: string): ThreadWorkspace {
  const socketPath = path.join(sandbox, "supervisor", "helper.sock");
  return new ThreadWorkspace({
    workspaceDirectory: path.join(sandbox, "workspace"),
    supervisorStateDirectory: path.join(sandbox, "supervisor"),
    credentialSocketPath: socketPath,
    launcher: recordingLauncher(),
    sourceEnvironment: {
      PATH: searchPath,
      HOME: sandbox,
      SECRET_OF_THE_SUPERVISOR: "never-passed",
    },
    reportEvent: (event) => events.push(event),
    requestCredential: async () => credentialAnswer(),
    logger: pino({ level: "trace" }, { write: (line: string) => logLines.push(line) }),
    credentialHelperCommand: describeCredentialHelperCommand(socketPath, [
      process.execPath,
      "--import",
      tsxLoader,
    ]),
  });
}

async function makeSandbox(name: string): Promise<string> {
  const sandbox = path.join(directory, name);
  await mkdir(path.join(sandbox, "workspace"), { recursive: true });
  await mkdir(path.join(sandbox, "supervisor"), { recursive: true });
  return sandbox;
}

function describeRepository(
  repository: FakeRepository,
  access: WorkspaceRepository["access"],
): WorkspaceRepository {
  return { url: repository.cloneUrl, access, baseBranch: null, workBranch, commitAuthor: author };
}

function gitIn(workspace: string, gitArguments: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      gitArguments,
      { cwd: workspace, env: { PATH: searchPath, GIT_CONFIG_GLOBAL: "/dev/null" } },
      (error, standardOutput, standardError) =>
        error === null ? resolve(standardOutput) : reject(new Error(standardError)),
    );
  });
}

function grantReadToken(): CredentialAnswer {
  const token = github.issueTokenForTest([privateRepository], { contents: "read" });
  grantedTokens.push(token);
  return { isGranted: true, credential: { username: "x-access-token", password: token } };
}

beforeAll(async () => {
  github = await FakeGithub.start();
  privateRepository = await github.createRepository({
    owner: "octo",
    name: "private",
    isPrivate: true,
    files: { "README.md": "# Private\n" },
  });
  publicRepository = await github.createRepository({
    owner: "octo",
    name: "public",
    isPrivate: false,
  });
}, 30_000);

afterAll(async () => {
  await github.close();
});

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "barrack-workspace-test-"));
  launches = [];
  events = [];
  logLines = [];
  grantedTokens = [];
  credentialAnswer = grantReadToken;
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the agent's workspace", () => {
  it("clones a public repository onto the work branch, with the user as author, and no credential", async () => {
    const sandbox = await makeSandbox("public");
    const workspace = createWorkspace(sandbox);

    await workspace.prepare({
      type: "prepare_workspace",
      repository: describeRepository(publicRepository, "none"),
      agentHasWorkedBefore: false,
    });

    const baseCommit = await github.readBranch(publicRepository, "main");
    expect(events).toEqual([
      {
        type: "repository_clone_started",
        repositoryUrl: publicRepository.cloneUrl,
        baseBranch: null,
      },
      {
        type: "repository_cloned",
        baseBranch: "main",
        baseCommit,
        workBranch,
        lostEarlierWork: false,
      },
    ]);
    const clone = path.join(sandbox, "workspace");
    expect((await gitIn(clone, ["branch", "--show-current"])).trim()).toBe(workBranch);
    expect((await gitIn(clone, ["config", "user.email"])).trim()).toBe(author.email);
    expect(await gitIn(clone, ["config", "--get-all", "credential.helper"])).toBe("\n");
    expect(await workspace.isReadyForMessages()).toBe(true);
    await workspace.stop();
  });

  it("clones a private repository with credentials asked for through the helper, and keeps them nowhere", async () => {
    const sandbox = await makeSandbox("private");
    const workspace = createWorkspace(sandbox);

    await workspace.prepare({
      type: "prepare_workspace",
      repository: describeRepository(privateRepository, "github_app"),
      agentHasWorkedBefore: false,
    });
    const clone = path.join(sandbox, "workspace");
    await gitIn(clone, ["fetch", "--quiet", "origin"]);
    await workspace.stop();

    expect(events.map((event) => event.type)).toEqual([
      "repository_clone_started",
      "repository_cloned",
    ]);
    expect(grantedTokens.length).toBeGreaterThan(0);
    const places = {
      configuration: await readFile(path.join(clone, ".git", "config"), "utf8"),
      commands: JSON.stringify(launches),
      events: JSON.stringify(events),
      logs: logLines.join("\n"),
    };
    for (const token of grantedTokens) {
      for (const [place, contents] of Object.entries(places)) {
        expect(contents.includes(token), `a token in the ${place}`).toBe(false);
      }
    }
    expect(places.commands).not.toContain("never-passed");
  });

  it("reports a clone that fails, keeps messages from the agent, and clones once it can", async () => {
    const sandbox = await makeSandbox("failing");
    const workspace = createWorkspace(sandbox);
    credentialAnswer = () => ({ isGranted: false, reason: "the owner disconnected GitHub" });

    await workspace.prepare({
      type: "prepare_workspace",
      repository: describeRepository(privateRepository, "github_app"),
      agentHasWorkedBefore: false,
    });
    const isReadyWhileRefused = await workspace.isReadyForMessages();
    credentialAnswer = grantReadToken;
    const isReadyOnceAllowed = await workspace.isReadyForMessages();
    await workspace.stop();

    expect(isReadyWhileRefused).toBe(false);
    expect(isReadyOnceAllowed).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "repository_clone_started",
      "repository_clone_failed",
      "repository_clone_started",
      "repository_clone_failed",
      "repository_clone_started",
      "repository_cloned",
    ]);
    expect(events[1]).toMatchObject({
      errorMessage: expect.stringContaining(`Cloning ${privateRepository.cloneUrl} failed`),
    });
  });

  it("gives the agent no message before the workspace is described, saying why, and does once it is", async () => {
    const sandbox = await makeSandbox("undescribed");
    const workspace = createWorkspace(sandbox);

    const beforeDescription = await workspace.isReadyForMessages();
    await workspace.prepare({
      type: "prepare_workspace",
      repository: describeRepository(publicRepository, "none"),
      agentHasWorkedBefore: false,
    });

    expect(beforeDescription).toBe(false);
    expect(events[0]).toEqual({
      type: "repository_clone_failed",
      errorMessage: expect.stringContaining("has not been told what its workspace should hold"),
    });
    expect(events.at(-1)).toMatchObject({ type: "repository_cloned" });
    expect(await workspace.isReadyForMessages()).toBe(true);
    await workspace.stop();
  });

  it("clones a repository whose base branch has a name Git accepts beyond plain letters", async () => {
    const sandbox = await makeSandbox("unusual-branch");
    const workspace = createWorkspace(sandbox);
    const baseBranch = "développement+1#12";
    await gitIn(publicRepository.directory, ["branch", baseBranch, "main"]);

    await workspace.prepare({
      type: "prepare_workspace",
      repository: { ...describeRepository(publicRepository, "none"), baseBranch },
      agentHasWorkedBefore: false,
    });

    expect(events.at(-1)).toMatchObject({ type: "repository_cloned", baseBranch });
    expect(await workspace.isReadyForMessages()).toBe(true);
    await workspace.stop();
  });

  it("reports a repository that does not exist", async () => {
    const sandbox = await makeSandbox("missing");
    const workspace = createWorkspace(sandbox);

    await workspace.prepare({
      type: "prepare_workspace",
      repository: {
        ...describeRepository(publicRepository, "none"),
        url: `${github.webUrl}/octo/nothing.git`,
      },
      agentHasWorkedBefore: false,
    });

    expect(events.at(-1)).toMatchObject({ type: "repository_clone_failed" });
    expect(await workspace.isReadyForMessages()).toBe(false);
  });

  it("does not clone again in a sandbox that already has the clone, as after a stop", async () => {
    const sandbox = await makeSandbox("resumed");
    const description = {
      type: "prepare_workspace" as const,
      repository: describeRepository(publicRepository, "none"),
      agentHasWorkedBefore: true,
    };
    await createWorkspace(sandbox).prepare(description);
    events = [];
    launches = [];

    const afterRestart = createWorkspace(sandbox);
    await afterRestart.prepare(description);

    expect(events).toEqual([]);
    expect(launches).toEqual([]);
    expect(await afterRestart.isReadyForMessages()).toBe(true);
  });

  it("says earlier work was lost when a sandbox made afresh clones for an agent that had worked", async () => {
    const sandbox = await makeSandbox("recreated");

    await createWorkspace(sandbox).prepare({
      type: "prepare_workspace",
      repository: describeRepository(publicRepository, "none"),
      agentHasWorkedBefore: true,
    });

    expect(events.at(-1)).toMatchObject({ type: "repository_cloned", lostEarlierWork: true });
  });
});

describe("the credential helper", () => {
  function runHelper(socketPath: string, operation: string, input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const helper = path.join(import.meta.dirname, "git-credential-helper-main.ts");
      const child = execFile(
        process.execPath,
        ["--import", tsxLoader, helper, socketPath, operation],
        (error, standardOutput) => (error === null ? resolve(standardOutput) : reject(error)),
      );
      child.stdin?.end(input);
    });
  }

  it("answers Git's get with a user name and password for the repository, and nothing for store, erase or another repository", async () => {
    const sandbox = await makeSandbox("helper");
    const workspace = createWorkspace(sandbox);
    await workspace.prepare({
      type: "prepare_workspace",
      repository: describeRepository(privateRepository, "github_app"),
      agentHasWorkedBefore: false,
    });
    const socketPath = path.join(sandbox, "supervisor", "helper.sock");
    const host = new URL(privateRepository.cloneUrl).host;
    const request = (repositoryPath: string, requestHost = host) =>
      `protocol=http\nhost=${requestHost}\npath=${repositoryPath}\n\n`;
    grantedTokens = [];

    const forRepository = await runHelper(socketPath, "get", request("octo/private.git"));
    const stored = await runHelper(
      socketPath,
      "store",
      `${request("octo/private.git")}password=x\n`,
    );
    const forAnotherRepository = await runHelper(socketPath, "get", request("octo/public.git"));
    const forAnotherHost = await runHelper(
      socketPath,
      "get",
      request("octo/private.git", "evil.example"),
    );
    await workspace.stop();

    expect(forRepository).toBe(`username=x-access-token\npassword=${grantedTokens[0]}\n`);
    expect(grantedTokens).toHaveLength(1);
    expect([stored, forAnotherRepository, forAnotherHost]).toEqual(["", "", ""]);
  });
});

describe("the publication bundle", () => {
  let uploads: Buffer[];
  let server: Server;
  let controlPlaneHttpUrl: string;

  beforeEach(async () => {
    uploads = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        uploads.push(Buffer.concat(chunks));
        response.end(
          request.headers.authorization === "Bearer supervisor-token" ? "ok" : undefined,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    controlPlaneHttpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function clonedWorkspace(name: string) {
    const sandbox = await makeSandbox(name);
    const workspace = createWorkspace(sandbox);
    await workspace.prepare({
      type: "prepare_workspace",
      repository: describeRepository(publicRepository, "none"),
      agentHasWorkedBefore: false,
    });
    const clone = path.join(sandbox, "workspace");
    await gitIn(clone, ["commit", "--quiet", "--allow-empty", "--message", "Agent's work"]);
    return { sandbox, workspace, clone };
  }

  function send(sandbox: string, workspace: ThreadWorkspace, maximumSizeInBytes: number) {
    return sendPublicationBundle(
      {
        type: "create_publication_bundle",
        publicationId: "publication-1",
        uploadPath: "/threads/thread-1/supervisor/publication-bundles/publication-1",
        maximumSizeInBytes,
      },
      {
        workspace,
        supervisorStateDirectory: path.join(sandbox, "supervisor"),
        controlPlaneHttpUrl,
        supervisorToken: "supervisor-token",
        logger: pino({ level: "silent" }),
      },
    );
  }

  it("is the work branch's commits since the base, made as the agent, and uploaded", async () => {
    const { sandbox, workspace, clone } = await clonedWorkspace("bundle");

    await send(sandbox, workspace, 1024 * 1024);

    expect(uploads).toHaveLength(1);
    const header = uploads[0]?.subarray(0, uploads[0].indexOf("\n\n")).toString() ?? "";
    const tip = (await gitIn(clone, ["rev-parse", "HEAD"])).trim();
    expect(header).toContain(`${tip} refs/heads/${workBranch}`);
    expect(launches.some((launch) => launch.arguments.includes("bundle"))).toBe(true);
  });

  it("is refused when it would be larger than the control plane accepts", async () => {
    const { sandbox, workspace } = await clonedWorkspace("too-large");

    await expect(send(sandbox, workspace, 16)).rejects.toThrow(/more than 16 bytes/);
    expect(uploads).toEqual([]);
  });

  it("is refused when the agent has committed nothing", async () => {
    const sandbox = await makeSandbox("nothing");
    const workspace = createWorkspace(sandbox);
    await workspace.prepare({
      type: "prepare_workspace",
      repository: describeRepository(publicRepository, "none"),
      agentHasWorkedBefore: false,
    });

    await expect(send(sandbox, workspace, 1024)).rejects.toThrow(/not committed anything/);
  });
});
