import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  maximumErrorMessageLength,
  type PrepareWorkspace,
  type WorkspaceEvent,
  type WorkspaceRepository,
} from "@barrack/protocol";
import { z } from "zod";
import type { AgentProcessLauncher } from "../agent-process/agent-process-launcher.js";
import type { Logger } from "../logger.js";
import { shortenText } from "../shorten-text.js";
import { AgentGit, type GitOutcome } from "./agent-git.js";
import { type CredentialAnswer, GitCredentialServer } from "./git-credential-server.js";

/** A large repository over a slow link takes minutes; past this, something is wrong. */
const defaultCloneTimeoutInMilliseconds = 15 * 60_000;
const quickCommandTimeoutInMilliseconds = 60_000;

/** The supervisor's record of the clone, in its own state directory, which the agent cannot write. */
const cloneRecordFileName = "workspace-repository.json";

const cloneRecordSchema = z.object({
  url: z.string(),
  workBranch: z.string(),
  baseBranch: z.string(),
  baseCommit: z.string(),
});

export type CloneRecord = z.infer<typeof cloneRecordSchema>;

export type ThreadWorkspaceSettings = {
  /** Undefined for a sandbox with no workspace, where a repository cannot be cloned. */
  workspaceDirectory: string | undefined;
  supervisorStateDirectory: string;
  credentialSocketPath: string;
  launcher: AgentProcessLauncher;
  /** The supervisor's environment, which Git's is built from an allowlist of. */
  sourceEnvironment: NodeJS.ProcessEnv;
  /** Sends a workspace event to the control plane, numbered and acknowledged like the agent's. */
  reportEvent: (event: WorkspaceEvent) => void;
  requestCredential: () => Promise<CredentialAnswer>;
  logger: Logger;
  cloneTimeoutInMilliseconds?: number;
  /**
   * The command Git runs as its credential helper; this supervisor's own
   * helper (`describeCredentialHelperCommand`) unless a test gives another.
   */
  credentialHelperCommand?: string;
};

type WorkspaceState = "waiting_for_description" | "ready" | "needs_clone";

/**
 * Prepares the agent's workspace before the agent is given anything: clones
 * the thread's repository into it, as the agent, onto the thread's own work
 * branch, with the user as the author of the agent's commits.
 *
 * The clone happens once per sandbox. A sandbox that stops and starts again
 * finds its record of the clone (in the supervisor's state directory) and
 * its workspace as the agent left them. A sandbox made afresh after the
 * agent had worked in an earlier one clones again and says the earlier
 * work was lost. A clone that fails is reported, and the agent is given no
 * message while the workspace lacks the repository; each message tries the
 * clone again first. Nor is the agent given any message before the control
 * plane has described the workspace (it does after every welcome): one
 * that arrives first, because the description was refused as invalid, say,
 * is withheld and reported the same way, rather than reaching an agent
 * without the repository it was promised.
 *
 * The clone is partial (`--filter=blob:none`): the whole history, so the
 * agent can read logs and blame and publishing can bundle against the base
 * commit, with file contents fetched as they are needed. Starting is quick
 * even for a large repository, and nothing publishing needs is missing.
 */
export class ThreadWorkspace {
  readonly #settings: ThreadWorkspaceSettings;
  #state: WorkspaceState = "waiting_for_description";
  #repository: WorkspaceRepository | undefined;
  #agentHasWorkedBefore = false;
  #credentialServer: GitCredentialServer | undefined;

  constructor(settings: ThreadWorkspaceSettings) {
    this.#settings = settings;
  }

  /** What the control plane says the workspace should hold; sent after every welcome. */
  async prepare(description: PrepareWorkspace): Promise<void> {
    this.#agentHasWorkedBefore = description.agentHasWorkedBefore;
    const { repository } = description;
    if (repository === null) {
      this.#state = "ready";
      return;
    }
    this.#repository = repository;
    await this.#startCredentialServer(repository);
    if (this.#state === "ready" || (await this.readCloneRecord()) !== undefined) {
      this.#state = "ready";
      return;
    }
    if (this.#state === "needs_clone") {
      // Tried and failed already: the next message tries again, not every reconnection.
      return;
    }
    await this.#clone(repository);
  }

  /**
   * Whether the agent may be given a message now. A repository that is not
   * cloned yet is cloned first; until that succeeds, the answer is no. Before
   * the workspace has been described, the answer is no, and the user is told.
   */
  async isReadyForMessages(): Promise<boolean> {
    if (this.#state === "waiting_for_description") {
      this.#reportMissingDescription();
      return false;
    }
    if (this.#state !== "needs_clone" || this.#repository === undefined) {
      return true;
    }
    return this.#clone(this.#repository);
  }

  /** The clone, once there is one; read from the supervisor's own record. */
  async readCloneRecord(): Promise<CloneRecord | undefined> {
    try {
      const recorded: unknown = JSON.parse(await readFile(this.#cloneRecordPath(), "utf8"));
      return cloneRecordSchema.parse(recorded);
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
  }

  get git(): AgentGit | undefined {
    const { workspaceDirectory, launcher, sourceEnvironment } = this.#settings;
    return workspaceDirectory === undefined
      ? undefined
      : new AgentGit(launcher, workspaceDirectory, sourceEnvironment);
  }

  async stop(): Promise<void> {
    await this.#credentialServer?.stop();
  }

  #reportMissingDescription(): void {
    this.#settings.logger.error(
      "A user message arrived before the control plane described the workspace; withholding it",
    );
    this.#settings.reportEvent({
      type: "repository_clone_failed",
      errorMessage:
        "This sandbox has not been told what its workspace should hold (the control plane's description of it did not arrive, or could not be read), so the agent is given no messages. Stop the thread and resume it to try again.",
    });
  }

  async #startCredentialServer(repository: WorkspaceRepository): Promise<void> {
    if (repository.access !== "github_app" || this.#credentialServer !== undefined) {
      return;
    }
    const server = new GitCredentialServer({
      socketPath: this.#settings.credentialSocketPath,
      repositoryUrl: repository.url,
      requestCredential: this.#settings.requestCredential,
      logger: this.#settings.logger,
    });
    await server.start();
    this.#credentialServer = server;
  }

  /** Returns whether the repository is now cloned. */
  async #clone(repository: WorkspaceRepository): Promise<boolean> {
    const { reportEvent, logger } = this.#settings;
    reportEvent({
      type: "repository_clone_started",
      repositoryUrl: repository.url,
      baseBranch: repository.baseBranch,
    });
    logger.info({ repositoryUrl: repository.url }, "Cloning the thread's repository");
    try {
      const record = await this.#cloneOntoWorkBranch(repository);
      await this.#writeCloneRecord(record);
      this.#state = "ready";
      reportEvent({
        type: "repository_cloned",
        baseBranch: record.baseBranch,
        baseCommit: record.baseCommit,
        workBranch: record.workBranch,
        lostEarlierWork: this.#agentHasWorkedBefore,
      });
      logger.info({ baseCommit: record.baseCommit }, "Cloned the thread's repository");
      return true;
    } catch (error) {
      this.#state = "needs_clone";
      const reason = error instanceof Error ? error.message : "for a reason Git did not give";
      logger.warn({ reason }, "Could not clone the thread's repository");
      reportEvent({
        type: "repository_clone_failed",
        errorMessage: shortenText(
          `Cloning ${repository.url} failed: ${reason} The agent is given no messages while its workspace lacks the repository; send another message to try again.`,
          maximumErrorMessageLength,
          0.5,
        ),
      });
      return false;
    }
  }

  async #cloneOntoWorkBranch(repository: WorkspaceRepository): Promise<CloneRecord> {
    const git = this.git;
    if (git === undefined) {
      throw new Error("this sandbox has no workspace to clone it into.");
    }
    await this.#emptyWorkspace(git);
    await expectSuccess(
      git.run(this.#cloneArguments(repository), {
        timeoutInMilliseconds:
          this.#settings.cloneTimeoutInMilliseconds ?? defaultCloneTimeoutInMilliseconds,
      }),
    );
    const baseBranch = (
      await expectSuccess(git.run(["symbolic-ref", "--short", "HEAD"], quick()))
    ).trim();
    const baseCommit = (
      await expectSuccess(git.run(["rev-parse", "--verify", "HEAD^{commit}"], quick()))
    ).trim();
    await expectSuccess(git.run(["switch", "--create", repository.workBranch], quick()));
    return { url: repository.url, workBranch: repository.workBranch, baseBranch, baseCommit };
  }

  /**
   * Configures the clone in the same step: the user as author, and, for a
   * repository reached through the GitHub App, the helper that asks the
   * supervisor for credentials. Inherited helpers are cleared first, so no
   * other helper is asked, and none can store what is returned.
   */
  #cloneArguments(repository: WorkspaceRepository): string[] {
    const configuration = [
      `user.name=${repository.commitAuthor.name}`,
      `user.email=${repository.commitAuthor.email}`,
      "credential.helper=",
      ...(repository.access === "github_app"
        ? [
            `credential.helper=${this.#settings.credentialHelperCommand ?? describeCredentialHelperCommand(this.#settings.credentialSocketPath)}`,
            "credential.useHttpPath=true",
          ]
        : []),
    ];
    return [
      "clone",
      "--filter=blob:none",
      ...(repository.baseBranch === null ? [] : ["--branch", repository.baseBranch]),
      ...configuration.flatMap((setting) => ["--config", setting]),
      "--",
      repository.url,
      ".",
    ];
  }

  /**
   * A workspace without a clone record holds at most what a clone cut short
   * left, since the agent is given nothing before the clone succeeds; Git
   * clones only into an empty directory. Removed as the agent, whose files
   * they are.
   */
  async #emptyWorkspace(git: AgentGit): Promise<void> {
    await expectSuccess(
      git.runProgram(
        process.execPath,
        [
          "-e",
          'const fs = require("node:fs"); for (const entry of fs.readdirSync(".")) fs.rmSync(entry, { recursive: true, force: true });',
        ],
        quick(),
      ),
    );
  }

  async #writeCloneRecord(record: CloneRecord): Promise<void> {
    const recordPath = this.#cloneRecordPath();
    const temporaryPath = `${recordPath}.writing`;
    await writeFile(temporaryPath, JSON.stringify(record), { mode: 0o600 });
    await rename(temporaryPath, recordPath);
  }

  #cloneRecordPath(): string {
    return path.join(this.#settings.supervisorStateDirectory, cloneRecordFileName);
  }
}

/**
 * The command Git runs as its credential helper: `nodeCommand`, this Node
 * with the same loader (such as tsx under `pnpm dev`) unless given another,
 * running the helper's entry point, given the socket. Git runs a value starting with `!` through the shell,
 * so each word is quoted. Nothing in it is secret.
 */
export function describeCredentialHelperCommand(
  socketPath: string,
  nodeCommand: readonly string[] = [process.execPath, ...process.execArgv],
): string {
  const thisFile = fileURLToPath(import.meta.url);
  const helperEntryPoint = path.join(
    path.dirname(thisFile),
    `git-credential-helper-main${path.extname(thisFile)}`,
  );
  const words = [...nodeCommand, helperEntryPoint, socketPath];
  return `!${words.map(quoteForShell).join(" ")}`;
}

function quoteForShell(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

function quick(): { timeoutInMilliseconds: number } {
  return { timeoutInMilliseconds: quickCommandTimeoutInMilliseconds };
}

/** Git's standard output, or an error with what Git said went wrong. */
async function expectSuccess(outcome: Promise<GitOutcome>): Promise<string> {
  const { exitCode, standardOutput, standardError } = await outcome;
  if (exitCode === 0) {
    return standardOutput;
  }
  throw new Error(describeGitFailure(standardError, exitCode));
}

/** Git's own reasons, which name no credential: the lines it starts with `fatal:` or `error:`. */
export function describeGitFailure(standardError: string, exitCode: number | null): string {
  const reasons = standardError
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(fatal|error|remote):/.test(line));
  const said = reasons.length > 0 ? reasons.slice(-3).join(" ") : standardError.trim().slice(-500);
  return exitCode === null
    ? `Git took too long and was stopped. ${said}`.trim()
    : `${said || `Git exited with status ${exitCode}.`}`;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
