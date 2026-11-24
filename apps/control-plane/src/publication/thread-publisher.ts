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
  ThreadRepositoryRecord,
  ThreadRepositoryStore,
} from "../repositories/thread-repository-store.js";
import type { PublicationOutcomeEvent } from "../thread-event-log/thread-event-log.js";
import type { ThreadRecord, ThreadStore } from "../threads/thread-store.js";
import { maximumBundleHeaderLength, parseBundleHeader } from "./bundle-header.js";
import { GitCommandError, IsolatedGitRepository } from "./isolated-git-repository.js";
import { type PublicationBundleUploads, PublicationError } from "./publication-bundle-uploads.js";
import { describePublishing } from "./publishing-availability.js";

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

/** How the publisher reaches a thread's supervisor and history. */
export type PublicationChannel = {
  sendWorkspaceMessage(threadId: string, message: ControlPlaneWorkspaceMessage): boolean;
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
  logger: Logger;
  maximumBundleSizeInBytes?: number;
};

type Verified = {
  thread: ThreadRecord;
  repository: ThreadRepositoryRecord;
  api: GithubApi;
  /** Minted for each publication: names its bundle upload and keys its outcome in history. */
  publicationId: string;
};

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
 * 4. Push to `barrack/<thread>` only, and only over the commit Barrack
 *    pushed there last: a branch someone else pushed to is never
 *    overwritten. A second publication after the agent rewrote its own
 *    commits replaces them; nothing but Barrack's own work is ever lost.
 * 5. Open a pull request as the App if asked and none is recorded; one is
 *    opened at most once, and later publications update its branch.
 *
 * Every outcome is recorded in the thread's history.
 */
export class ThreadPublisher {
  readonly #options: ThreadPublisherOptions;
  readonly #underWay = new Set<string>();

  constructor(options: ThreadPublisherOptions) {
    this.#options = options;
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
    this.#underWay.add(threadId);
    try {
      return await this.#publishAndRecord(checked, request.openPullRequest);
    } finally {
      this.#underWay.delete(threadId);
    }
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
    return { thread, repository, api, publicationId: randomUUID() };
  }

  async #publishAndRecord(verified: Verified, openPullRequest: boolean): Promise<PublishOutcome> {
    const { publicationId } = verified;
    const { threadId } = verified.thread;
    const { channel, logger } = this.#options;
    try {
      const publication = await this.#publish(verified, openPullRequest);
      await channel.recordPublicationOutcome(threadId, publicationId, publication.event);
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
      await channel
        .recordPublicationOutcome(threadId, publicationId, {
          type: "repository_publication_failed",
          errorMessage: error.message,
        })
        .catch((recordingError: unknown) =>
          logger.error({ err: recordingError, threadId }, "Could not record a failed publication"),
        );
      return { kind: "failed", message: error.message };
    }
  }

  async #publish(
    verified: Verified,
    openPullRequest: boolean,
  ): Promise<{ response: PublishThreadResponse; event: RepositoryPublishedEvent }> {
    const { thread, repository, api } = verified;
    const { connection, linked } = await this.#verifyAccess(thread, repository, api);
    const pushToken = await api.createInstallationToken(linked.installationId, linked.id, {
      contents: "write",
    });
    const isolated = await IsolatedGitRepository.create({
      remoteUrl: repository.url,
      credentials: { username: "x-access-token", password: pushToken.token },
      allowPlainHttp: this.#options.settings.allowPlainHttp,
    });
    try {
      const commit = await this.#pushWorkBranch(verified, isolated);
      const pullRequest = await this.#ensurePullRequest(
        verified,
        connection,
        linked,
        openPullRequest,
      );
      await this.#options.repositories.recordPublication(thread.threadId, {
        lastPublishedCommit: commit,
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

  /** Returns the commit the work branch now points at in the repository. */
  async #pushWorkBranch(verified: Verified, isolated: IsolatedGitRepository): Promise<string> {
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
    await isolated.fetchBaseBranch(repository.baseBranch);
    await this.#checkBundle(isolated, bundlePath, header.value.packOffset);
    await isolated.fetchBranchFromBundle(bundlePath, reference);
    const commit = header.value.tipCommit;
    const remoteCommit = await isolated.readRemoteBranch(reference);
    if (remoteCommit !== undefined && remoteCommit !== repository.lastPublishedCommit) {
      throw new PublicationError(
        `${repository.workBranch} in the repository has commits Barrack did not push there. Barrack never overwrites someone else's work; delete or rename that branch on GitHub to publish again.`,
      );
    }
    if (remoteCommit !== commit) {
      await isolated.push(reference, commit, remoteCommit);
    }
    return commit;
  }

  async #checkBundle(isolated: IsolatedGitRepository, bundlePath: string, packOffset: number) {
    try {
      await isolated.verifyBundle(bundlePath);
    } catch {
      throw new PublicationError(
        "The branch's commits build on history the repository's base branch does not have (was the base branch rewritten?), so they cannot be published.",
      );
    }
    try {
      await isolated.checkBundleObjects(bundlePath, packOffset);
    } catch (error) {
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
