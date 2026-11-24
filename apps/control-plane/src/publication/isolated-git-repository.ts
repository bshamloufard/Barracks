import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  type ApplicableLimits,
  boundedGitSettings,
  type GitChildLimits,
  type LimitedResource,
} from "./git-child-limits.js";
import { runLimitedGit } from "./run-limited-git.js";

/**
 * A bare repository the control plane makes for one publication and throws
 * away after it, in which a sandbox's bundle is checked and from which the
 * work branch is pushed. Git runs here with the control plane's privileges,
 * so nothing from the sandbox may configure or extend it:
 *
 * - no system or user configuration is read, and no hooks run (hooks come
 *   only from the repository's own directory, which this code made, and are
 *   switched off besides);
 * - the only network protocol is HTTPS (plain HTTP only where explicitly
 *   allowed for tests), and reading the bundle file is allowed only for the
 *   one command that reads it;
 * - every object received is checked (`fsckObjects`), which refuses trees
 *   that would plant `.git` directories, hooks or configuration in a
 *   checkout, among other malformed objects;
 * - nothing is ever checked out;
 * - every command runs under the publication's limits on memory, processor
 *   time, wall time and disk (`GitChildLimits`), since both the bundle and
 *   the repository's history are someone else's to make as large as they
 *   like.
 *
 * The write-capable token reaches Git only through a credential helper that
 * reads it from the environment of Git's own process. It is never in a URL,
 * an argument or a file, and error messages are scrubbed of it.
 */

/** Git is found where the control plane finds its other programs. */
const { PATH: searchPath } = process.env;

export type RepositoryCredentials = { username: string; password: string };

export type IsolatedGitRepositoryOptions = {
  remoteUrl: string;
  credentials: RepositoryCredentials;
  allowPlainHttp: boolean;
  limits: GitChildLimits;
  applicableLimits: ApplicableLimits;
};

export class GitCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCommandError";
  }
}

/** A Git command was stopped for going over one of the publication's limits. */
export class GitLimitExceededError extends GitCommandError {
  readonly resource: LimitedResource;

  constructor(command: string, resource: LimitedResource) {
    super(`git ${command} went over the publication's limit on ${resource.replace("_", " ")}`);
    this.name = "GitLimitExceededError";
    this.resource = resource;
  }
}

export class IsolatedGitRepository {
  readonly #directory: string;
  readonly #repositoryPath: string;
  readonly #options: IsolatedGitRepositoryOptions;

  private constructor(directory: string, options: IsolatedGitRepositoryOptions) {
    this.#directory = directory;
    this.#repositoryPath = path.join(directory, "repository.git");
    this.#options = options;
  }

  /** A directory only this process's user can read, for the bundle and the repository. */
  static async create(options: IsolatedGitRepositoryOptions): Promise<IsolatedGitRepository> {
    const directory = await mkdtemp(path.join(tmpdir(), "barrack-publication-"));
    return new IsolatedGitRepository(directory, options);
  }

  get directory(): string {
    return this.#directory;
  }

  /**
   * Fetches the base branch's history without file contents (a partial
   * clone): enough to check the bundle's prerequisites and to push, while
   * contents a thin bundle's deltas need are fetched on demand.
   */
  async fetchBaseBranch(baseBranch: string): Promise<void> {
    await this.#run(
      [
        "clone",
        "--bare",
        "--filter=blob:none",
        "--single-branch",
        "--no-tags",
        "--branch",
        baseBranch,
        "--",
        this.#options.remoteUrl,
        this.#repositoryPath,
      ],
      this.#directory,
    );
  }

  /** Fails unless every commit the bundle builds on is in the repository. */
  async verifyBundle(bundlePath: string): Promise<void> {
    await this.#runInRepository(["bundle", "verify", "--quiet", bundlePath]);
  }

  /**
   * Indexes the bundle's pack with every object checked, before any of it is
   * taken in as a branch. `git fetch` from a bundle does not check objects
   * even when told to (Git 2.43), so this is done separately.
   */
  async checkBundleObjects(bundlePath: string, packOffset: number): Promise<void> {
    await this.#runInRepository(["index-pack", "--stdin", "--fix-thin", "--fsck-objects"], {
      input: createReadStream(bundlePath, { start: packOffset }),
    });
  }

  /** Takes in the work branch from the bundle, and only that. */
  async fetchBranchFromBundle(bundlePath: string, reference: string): Promise<void> {
    await this.#runInRepository(
      ["fetch", "--no-tags", "--no-write-fetch-head", bundlePath, `+${reference}:${reference}`],
      { allowBundleFile: true },
    );
  }

  /** Whether `ancestor` is reachable from `descendant`. */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.#runInRepository(["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  /** The commit the branch points at in the remote repository now, or undefined if it does not exist. */
  async readRemoteBranch(reference: string): Promise<string | undefined> {
    const output = await this.#runInRepository(["ls-remote", "origin", reference]);
    const line = output.split("\n").find((entry) => entry.endsWith(`\t${reference}`));
    return line?.split("\t")[0];
  }

  /**
   * Pushes `commit` to `reference`, but only if the remote branch is still
   * at `expectedRemoteCommit` (absent, when undefined): Git's lease, which
   * makes the push fail rather than overwrite anything pushed since.
   */
  async push(
    reference: string,
    commit: string,
    expectedRemoteCommit: string | undefined,
  ): Promise<void> {
    await this.#runInRepository([
      "push",
      "--porcelain",
      `--force-with-lease=${reference}:${expectedRemoteCommit ?? ""}`,
      "origin",
      `${commit}:${reference}`,
    ]);
  }

  async discard(): Promise<void> {
    await rm(this.#directory, { recursive: true, force: true });
  }

  #runInRepository(
    gitArguments: string[],
    options: { allowBundleFile?: boolean; input?: Readable } = {},
  ): Promise<string> {
    return this.#run(gitArguments, this.#repositoryPath, options);
  }

  async #run(
    gitArguments: string[],
    workingDirectory: string,
    options: { allowBundleFile?: boolean; input?: Readable } = {},
  ): Promise<string> {
    const outcome = await runLimitedGit({
      gitArguments,
      workingDirectory,
      environment: this.#environment(options.allowBundleFile ?? false),
      ...(options.input === undefined ? {} : { input: options.input }),
      scratchDirectory: this.#directory,
      limits: this.#options.limits,
      applicable: this.#options.applicableLimits,
    });
    switch (outcome.kind) {
      case "succeeded":
        return outcome.standardOutput;
      case "limit_exceeded":
        throw new GitLimitExceededError(gitArguments[0] ?? "", outcome.resource);
      case "failed":
        throw this.#describeFailure(gitArguments, outcome.standardError);
    }
  }

  /**
   * Git's environment, built from nothing: configuration through `GIT_CONFIG_*`
   * variables, which apply to this command alone, and the token where only
   * the credential helper below reads it.
   */
  #environment(allowBundleFile: boolean): NodeJS.ProcessEnv {
    const settings: Array<[string, string]> = [
      ["core.hooksPath", "/dev/null"],
      ["core.fsmonitor", "false"],
      ["init.templateDir", ""],
      ["protocol.allow", "never"],
      ["protocol.https.allow", "always"],
      ...(this.#options.allowPlainHttp
        ? [["protocol.http.allow", "always"] as [string, string]]
        : []),
      ...(allowBundleFile ? [["protocol.file.allow", "always"] as [string, string]] : []),
      ["transfer.fsckObjects", "true"],
      ["fetch.fsckObjects", "true"],
      ...boundedGitSettings,
      ["credential.helper", ""],
      [
        "credential.helper",
        '!f() { test "$1" = get && printf "username=%s\\npassword=%s\\n" "$BARRACK_GIT_USERNAME" "$BARRACK_GIT_PASSWORD"; }; f',
      ],
    ];
    const environment: NodeJS.ProcessEnv = {
      PATH: searchPath,
      HOME: this.#directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      // Each allocator arena reserves address space; Git here runs one thread.
      MALLOC_ARENA_MAX: "1",
      BARRACK_GIT_USERNAME: this.#options.credentials.username,
      BARRACK_GIT_PASSWORD: this.#options.credentials.password,
      GIT_CONFIG_COUNT: String(settings.length),
    };
    settings.forEach(([key, value], index) => {
      environment[`GIT_CONFIG_KEY_${index}`] = key;
      environment[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    return environment;
  }

  #describeFailure(gitArguments: string[], standardError: string): GitCommandError {
    const scrubbed = standardError
      .replaceAll(this.#options.credentials.password, "[credential]")
      .trim()
      .split("\n")
      .slice(-5)
      .join(" ");
    return new GitCommandError(`git ${gitArguments[0]} failed: ${scrubbed || "no reason given"}`);
  }
}
