import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  buildPublicationBundleUploadPath,
  type ControlPlaneWorkspaceMessage,
  type PublishThreadResponse,
  type RepositoryPublishedEvent,
} from "@barrack/protocol";
import { type GithubApi, GithubApiError, type PullRequest } from "../github/github-api.js";
import type {
  GithubConnectionRecord,
  GithubConnectionStore,
  LinkedGithubRepository,
} from "../github/github-connection-store.js";
import { githubUnavailableReason } from "../github/github-connections.js";
import type { GithubSettings } from "../github/github-settings.js";
import { checkLiveRepositoryAccess } from "../github/live-repository-access.js";
import type { Logger } from "../logger.js";
import type {
  RepositoryPublication,
  ThreadRepositoryRecord,
  ThreadRepositoryStore,
} from "../repositories/thread-repository-store.js";
import type { Clock } from "../sandbox-lifecycle/lifecycle-settings.js";
import type { PublicationOutcomeEvent } from "../thread-event-log/thread-event-log.js";
import type { ThreadEndingListener } from "../thread-relay/thread-endings.js";
import type { ThreadRecord, ThreadStore } from "../threads/thread-store.js";
import { maximumBundleHeaderLength, parseBundleHeader } from "./bundle-header.js";
import {
  defaultGitChildLimits,
  findApplicableLimits,
  type GitChildLimits,
  type LimitedResource,
} from "./git-child-limits.js";
import {
  GitCommandError,
  GitLimitExceededError,
  IsolatedGitRepository,
} from "./isolated-git-repository.js";
import {
  PublicationAbandonedError,
  type PublicationBundleUploads,
  PublicationError,
} from "./publication-bundle-uploads.js";
import { describePublishing } from "./publishing-availability.js";
import { decidePush } from "./push-decision.js";

/** Far more than an agent's commits on a task come to; a bundle larger than this is refused. */
export const maximumPublicationBundleSizeInBytes = 100 * 1024 * 1024;

/** How long the sandbox has to make and send the bundle. */
const bundleTimeoutInMilliseconds = 3 * 60_000;

const maximumPullRequestTitleLength = 200;

export type PublishOutcome =
  | { kind: "published"; publication: PublishThreadResponse }
  | { kind: "not_found" }
  | { kind: "conflict"; message: string }
  | { kind: "failed"; message: string };

/** How the publisher reaches a thread's supervisor and history, and learns that it is stopping or going. */
export type PublicationChannel = {
  sendWorkspaceMessage(threadId: string, message: ControlPlaneWorkspaceMessage): boolean;
  listenForEndings(listener: ThreadEndingListener): void;
  /** Records a publication's outcome; at most once per publication, however often it is called. */
  recordPublicationOutcome(
    threadId: string,
    publicationId: string,
    event: PublicationOutcomeEvent,
  ): Promise<void>;
};

export type ThreadPublisherOptions = {
  threadStore: ThreadStore;
  repositories: ThreadRepositoryStore;
  connections: GithubConnectionStore;
  settings: GithubSettings;
  api: GithubApi | undefined;
  uploads: PublicationBundleUploads;
  channel: PublicationChannel;
  clock: Clock;
  logger: Logger;
  maximumBundleSizeInBytes?: number;
  /** What each Git process may use; `defaultGitChildLimits` unless a test needs tighter ones. */
  gitChildLimits?: GitChildLimits;
};

type Verified = {
  thread: ThreadRecord;
  repository: ThreadRepositoryRecord;
  api: GithubApi;
  /** Minted for each publication: names its bundle upload and keys its outcome in history. */
  publicationId: string;
  /** Aborted once the thread begins being deleted. */
  abandonment: AbortController;
};

/**
 * How often a publication under way notes activity in its thread, so that
 * idle shutdown does not stop the sandbox while it makes the bundle: well
 * within any idle period of a minute or more.
 */
const activityIntervalInMilliseconds = 30_000;

const stoppingReason =
  "The thread's sandbox is stopping, so it cannot send the branch's commits. Resume the thread, then publish again.";

/**
 * Publishes a thread's work branch: the control plane, never the sandbox,
 * pushes it and opens the pull request, with write-capable tokens that never
 * leave the control plane.
 *
 * 1. Check, with GitHub, that the thread's owner may still push to the
 *    repository through the App.
 * 2. Ask the supervisor for the work branch's commits since the base, as a
 *    Git bundle it uploads.
 * 3. Treat the bundle as hostile: read its header (one reference, the work
 *    branch), check it builds on the repository's own history, check every
 *    object in it, all in a throwaway repository Git cannot be configured
 *    or extended in (see `IsolatedGitRepository`).
 * 4. Push to `barrack/<thread>` only, as a fast-forward, or replacing
 *    Barrack's own last push when nothing anyone else pushed lies beneath
 *    it (`decidePush`): a publication after the agent rewrote its own
 *    commits replaces them, and nothing but Barrack's own work is ever
 *    lost.
 * 5. Open a pull request as the App if asked and none is recorded; one is
 *    opened at most once, and later publications update its branch.
 *
 * Every outcome is recorded in the thread's history, unless the thread
 * began being deleted meanwhile: the publication is then abandoned where it
 * is (Git killed, nothing pushed after that) and records nothing. A sandbox
 * that begins stopping fails a publication still waiting for its bundle at
 * once; one that has its bundle carries on without it.
 */
export class ThreadPublisher {
  readonly #options: ThreadPublisherOptions;
  readonly #underWay = new Map<string, AbortController>();

  constructor(options: ThreadPublisherOptions) {
    this.#options = options;
    options.channel.listenForEndings((threadId, ending) => {
      if (ending === "deletion") {
        this.#underWay.get(threadId)?.abort(new PublicationAbandonedError());
        options.uploads.abandonThread(threadId, new PublicationAbandonedError().message);
      } else {
        options.uploads.abandonThread(threadId, stoppingReason);
      }
    });
  }

  async publish(
    ownerUserId: string,
    threadId: string,
    request: { openPullRequest: boolean },
  ): Promise<PublishOutcome> {
    const checked = await this.#checkPublishable(ownerUserId, threadId);
    if ("kind" in checked) {
      return checked;
    }
    if (this.#underWay.has(threadId)) {
      return { kind: "conflict", message: "This thread's branch is already being published." };
    }
    this.#underWay.set(threadId, checked.abandonment);
    const stopNotingActivity = this.#noteActivityWhileUnderWay(threadId);
    try {
      return await this.#publishAndRecord(checked, request.openPullRequest);
    } finally {
      stopNotingActivity();
      this.#underWay.delete(threadId);
    }
  }

  /**
   * A publication counts as activity in its thread, at once and then
   * regularly, in the thread's record, where idle shutdown on any control
   * plane reads it.
   */
  #noteActivityWhileUnderWay(threadId: string): () => void {
    const { threadStore, clock, logger } = this.#options;
    const noteActivity = () => {
      threadStore
        .recordActivity(threadId, clock())
        .catch((error: unknown) =>
          logger.error({ err: error, threadId }, "Could not note a publication as activity"),
        );
    };
    noteActivity();
    const timer = setInterval(noteActivity, activityIntervalInMilliseconds);
    return () => clearInterval(timer);
  }

  async #checkPublishable(
    ownerUserId: string,
    threadId: string,
  ): Promise<Verified | Exclude<PublishOutcome, { kind: "published" }>> {
    const { threadStore, repositories, api } = this.#options;
    const thread = await threadStore.findOwnedBy(ownerUserId, threadId);
    if (thread === undefined) {
      return { kind: "not_found" };
    }
    const repository = await repositories.find(threadId);
    if (repository === undefined) {
      return { kind: "conflict", message: "This thread has no repository to publish." };
    }
    const publishing = describePublishing(repository, api !== undefined);
    if (!publishing.isAvailable) {
      return { kind: "conflict", message: publishing.reason };
    }
    if (api === undefined) {
      return { kind: "conflict", message: githubUnavailableReason };
    }
    if (thread.sandbox.state !== "running") {
      return {
        kind: "conflict",
        message:
          "Its sandbox must be running to publish its branch: resume the thread, or send it a message, first.",
      };
    }
    return {
      thread,
      repository,
      api,
      publicationId: randomUUID(),
      abandonment: new AbortController(),
    };
  }

  async #publishAndRecord(verified: Verified, openPullRequest: boolean): Promise<PublishOutcome> {
    const { threadId } = verified.thread;
    const { logger } = this.#options;
    try {
      const publication = await this.#publish(verified, openPullRequest);
      await this.#recordUnlessDeleted(verified, publication.event);
      logger.info(
        {
          threadId,
          commit: publication.response.commit,
          pullRequestUrl: publication.response.pullRequestUrl,
        },
        "Published the thread's branch",
      );
      return { kind: "published", publication: publication.response };
    } catch (error) {
      if (!isExpectedFailure(error)) {
        throw error;
      }
      logger.warn({ err: error, threadId }, "Could not publish the thread's branch");
      await this.#recordUnlessDeleted(verified, {
        type: "repository_publication_failed",
        errorMessage: error.message,
      }).catch((recordingError: unknown) =>
        logger.error({ err: recordingError, threadId }, "Could not record a failed publication"),
      );
      return { kind: "failed", message: error.message };
    }
  }

  /**
   * Nothing is recorded for a thread whose deletion has begun: on this
   * control plane the publication was abandoned, and the record says so for
   * one being deleted through another.
   */
  async #recordUnlessDeleted(verified: Verified, event: PublicationOutcomeEvent): Promise<void> {
    const { threadId } = verified.thread;
    if (!(await this.#isThreadStillThere(verified))) {
      this.#options.logger.info(
        { threadId, publicationId: verified.publicationId },
        "Recorded nothing of a publication whose thread is being deleted",
      );
      return;
    }
    await this.#options.channel.recordPublicationOutcome(threadId, verified.publicationId, event);
  }

  async #isThreadStillThere(verified: Verified): Promise<boolean> {
    if (verified.abandonment.signal.aborted) {
      return false;
    }
    const thread = await this.#options.threadStore.find(verified.thread.threadId);
    return thread !== undefined && thread.sandbox.state !== "deleting";
  }

  /** Throws `PublicationAbandonedError` if the thread has begun being deleted. */
  async #ensureThreadStillThere(verified: Verified): Promise<void> {
    if (!(await this.#isThreadStillThere(verified))) {
      throw new PublicationAbandonedError();
    }
  }

  async #publish(
    verified: Verified,
    openPullRequest: boolean,
  ): Promise<{ response: PublishThreadResponse; event: RepositoryPublishedEvent }> {
    const { thread, repository, api } = verified;
    // Its deletion may have begun before this publication was registered to hear of it.
    await this.#ensureThreadStillThere(verified);
    const { connection, linked } = await this.#verifyAccess(thread, repository, api);
    const pushToken = await api.createInstallationToken(linked.installationId, linked.id, {
      contents: "write",
    });
    const isolated = await IsolatedGitRepository.create({
      remoteUrl: repository.url,
      credentials: { username: "x-access-token", password: pushToken.token },
      allowPlainHttp: this.#options.settings.allowPlainHttp,
      limits: this.#gitChildLimits,
      applicableLimits: findApplicableLimits(),
      signal: verified.abandonment.signal,
    });
    try {
      const { commit, branch } = await this.#pushWorkBranch(verified, isolated);
      verified.abandonment.signal.throwIfAborted();
      const pullRequest = await this.#ensurePullRequest(
        verified,
        connection,
        linked,
        openPullRequest,
      );
      await this.#options.repositories.recordPublication(thread.threadId, {
        ...branch,
        pullRequest: pullRequest?.pullRequest,
      });
      const branchUrl = `${linked.htmlUrl}/tree/${repository.workBranch}`;
      return {
        response: {
          workBranch: repository.workBranch,
          commit,
          branchUrl,
          pullRequestUrl: pullRequest?.pullRequest.url ?? null,
        },
        event: {
          type: "repository_published",
          workBranch: repository.workBranch,
          commit,
          branchUrl,
          pullRequest: pullRequest?.pullRequest ?? null,
          isPullRequestNew: pullRequest?.isNew ?? false,
        },
      };
    } finally {
      await isolated.discard();
      api.revokeInstallationToken(pushToken.token).catch((error: unknown) => {
        this.#options.logger.warn(
          { err: error, threadId: thread.threadId },
          "Could not revoke a push token after use; it expires within the hour",
        );
      });
    }
  }

  async #verifyAccess(
    thread: ThreadRecord,
    repository: ThreadRepositoryRecord,
    api: GithubApi,
  ): Promise<{ connection: GithubConnectionRecord; linked: LinkedGithubRepository }> {
    const connection =
      thread.ownerUserId === undefined
        ? undefined
        : await this.#options.connections.find(thread.ownerUserId);
    const linked = connection?.repositories.find(
      (candidate) => candidate.id === repository.github?.repositoryId,
    );
    if (connection === undefined || linked === undefined) {
      throw new PublicationError(
        "You are no longer verified to have access to this repository: reconnect GitHub in Settings, with Barrack's App installed on it.",
      );
    }
    const access = await checkLiveRepositoryAccess(api, connection, linked);
    if (!access.ok) {
      throw new PublicationError(access.reason);
    }
    return { connection, linked };
  }

  /**
   * Returns the commit the work branch now points at in the repository,
   * and what to record of the branch: changed only if Barrack pushed.
   */
  async #pushWorkBranch(
    verified: Verified,
    isolated: IsolatedGitRepository,
  ): Promise<{ commit: string; branch: Omit<RepositoryPublication, "pullRequest"> }> {
    const { repository, publicationId } = verified;
    const reference = `refs/heads/${repository.workBranch}`;
    const bundlePath = path.join(isolated.directory, "work.bundle");
    await this.#receiveBundle(verified.thread.threadId, publicationId, bundlePath);
    const header = parseBundleHeader(await readStart(bundlePath), reference);
    if (!header.ok) {
      throw new PublicationError(header.errorMessage);
    }
    if (repository.baseBranch === undefined) {
      throw new PublicationError(
        "The thread's base branch is not known, so it cannot be published.",
      );
    }
    const { baseBranch } = repository;
    await this.#withinLimits("Fetching the base branch's history", () =>
      isolated.fetchBaseBranch(baseBranch),
    );
    await this.#withinLimits("Checking the branch's commits", () =>
      this.#checkBundle(isolated, bundlePath, header.value.packOffset),
    );
    await this.#withinLimits("Taking in the branch's commits", () =>
      isolated.fetchBranchFromBundle(bundlePath, reference),
    );
    const commit = header.value.tipCommit;
    const remoteCommit = await this.#withinLimits("Reading the branch in the repository", () =>
      isolated.fetchRemoteBranch(reference),
    );
    const decision = await this.#withinLimits("Comparing the branch with the repository's", () =>
      decidePush({
        workBranch: repository.workBranch,
        commit,
        remoteCommit,
        replaceableCommit: repository.replaceableCommit,
        isAncestor: (ancestor, descendant) => isolated.isAncestor(ancestor, descendant),
      }).catch((error: unknown) => {
        if (error instanceof GitLimitExceededError || !(error instanceof GitCommandError)) {
          throw error;
        }
        this.#options.logger.warn({ err: error }, "Could not tell whether a push fast-forwards");
        throw new PublicationError(
          "Barrack could not tell whether these commits build on the branch in the repository, so it pushed nothing. Try again.",
        );
      }),
    );
    const unchanged = {
      lastPublishedCommit: repository.lastPublishedCommit,
      replaceableCommit: repository.replaceableCommit,
    };
    switch (decision.kind) {
      case "refuse":
        throw new PublicationError(decision.reason);
      case "already_there":
        return { commit, branch: unchanged };
      case "push": {
        await this.#ensureThreadStillThere(verified);
        const pushed = await this.#withinLimits("Pushing the branch", () =>
          isolated.push(reference, commit, decision.expectedRemoteCommit),
        );
        if (pushed === "branch_moved") {
          throw new PublicationError(
            `Someone pushed to ${repository.workBranch} while Barrack was publishing, so nothing was pushed and nothing of theirs was overwritten. Publish again.`,
          );
        }
        return {
          commit,
          branch: { lastPublishedCommit: commit, replaceableCommit: decision.replaceableAfter },
        };
      }
    }
  }

  get #gitChildLimits(): GitChildLimits {
    return this.#options.gitChildLimits ?? defaultGitChildLimits;
  }

  /** Runs a step, turning a Git command stopped by a limit into a failure that says which. */
  async #withinLimits<Result>(step: string, work: () => Promise<Result>): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof GitLimitExceededError)) {
        throw error;
      }
      this.#options.logger.warn({ err: error, step }, "A publication went over a limit");
      throw new PublicationError(
        `${step} ${describeExceededLimit(error.resource, this.#gitChildLimits)}, so the branch cannot be published.`,
      );
    }
  }

  async #checkBundle(isolated: IsolatedGitRepository, bundlePath: string, packOffset: number) {
    try {
      await isolated.verifyBundle(bundlePath);
    } catch (error) {
      if (error instanceof GitLimitExceededError) {
        throw error;
      }
      throw new PublicationError(
        "The branch's commits build on history the repository's base branch does not have (was the base branch rewritten?), so they cannot be published.",
      );
    }
    try {
      await isolated.checkBundleObjects(bundlePath, packOffset);
    } catch (error) {
      if (error instanceof GitLimitExceededError) {
        throw error;
      }
      this.#options.logger.warn({ err: error }, "A sandbox's bundle failed Git's object checks");
      throw new PublicationError(
        "The branch's commits contain objects Git refuses (such as a directory named .git), so they cannot be published.",
      );
    }
  }

  async #receiveBundle(threadId: string, publicationId: string, bundlePath: string): Promise<void> {
    const { uploads, channel } = this.#options;
    const maximumSizeInBytes =
      this.#options.maximumBundleSizeInBytes ?? maximumPublicationBundleSizeInBytes;
    const received = uploads.expect(
      { threadId, publicationId, destinationPath: bundlePath, maximumSizeInBytes },
      bundleTimeoutInMilliseconds,
    );
    const isSent = channel.sendWorkspaceMessage(threadId, {
      type: "create_publication_bundle",
      publicationId,
      uploadPath: buildPublicationBundleUploadPath(threadId, publicationId),
      maximumSizeInBytes,
    });
    if (!isSent) {
      uploads.abandon(
        publicationId,
        "The thread's sandbox is not connected to the control plane right now. Wait a moment, then try again.",
      );
    }
    await received;
  }

  async #ensurePullRequest(
    verified: Verified,
    connection: GithubConnectionRecord,
    linked: LinkedGithubRepository,
    openPullRequest: boolean,
  ): Promise<{ pullRequest: PullRequest; isNew: boolean } | undefined> {
    const { thread, repository, api } = verified;
    if (repository.pullRequest !== undefined) {
      return { pullRequest: repository.pullRequest, isNew: false };
    }
    if (!openPullRequest || repository.baseBranch === undefined) {
      return undefined;
    }
    const token = await api.createInstallationToken(linked.installationId, linked.id, {
      pull_requests: "write",
    });
    try {
      return await api.openPullRequest(token.token, linked.fullName, {
        title: pullRequestTitleFor(thread),
        body: pullRequestBodyFor(thread, connection.login),
        head: repository.workBranch,
        base: repository.baseBranch,
      });
    } finally {
      api.revokeInstallationToken(token.token).catch((error: unknown) => {
        this.#options.logger.warn(
          { err: error },
          "Could not revoke a pull request token after use",
        );
      });
    }
  }
}

function describeExceededLimit(resource: LimitedResource, limits: GitChildLimits): string {
  const mebibytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MiB`;
  switch (resource) {
    case "memory":
      return `needed more memory than a publication may use (${mebibytes(limits.addressSpaceInBytes)})`;
    case "processor_time":
      return `needed more processor time than a publication may use (${limits.processorSeconds} seconds)`;
    case "wall_time":
      return `took longer than a publication may take (${Math.round(limits.wallTimeInMilliseconds / 1000)} seconds)`;
    case "disk":
      return `needed more disk space than a publication may use (${mebibytes(limits.diskInBytes)})`;
  }
}

function pullRequestTitleFor(thread: ThreadRecord): string {
  const title = thread.title ?? `Changes from Barrack thread ${thread.threadId}`;
  return title.length > maximumPullRequestTitleLength
    ? `${title.slice(0, maximumPullRequestTitleLength - 1)}…`
    : title;
}

function pullRequestBodyFor(thread: ThreadRecord, login: string): string {
  return [
    `Opened by Barrack for @${login}, from thread \`${thread.threadId}\`.`,
    "",
    ...(thread.title === undefined ? [] : [`> ${thread.title}`, ""]),
    "The commits on this branch were made by a coding agent in an isolated sandbox. Review them as you would any contribution before merging: this repository's continuous integration runs this branch's code, with the secrets it gives branches of this repository.",
  ].join("\n");
}

async function readStart(filePath: string): Promise<Buffer> {
  const file = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maximumBundleHeaderLength + 8);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function isExpectedFailure(error: unknown): error is Error {
  return (
    error instanceof PublicationError ||
    error instanceof GitCommandError ||
    error instanceof GithubApiError
  );
}
