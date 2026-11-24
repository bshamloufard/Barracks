import type {
  ControlPlaneWorkspaceMessage,
  PrepareWorkspace,
  SupervisorWorkspaceMessage,
} from "@barrack/protocol";
import type { GithubConnectionStore } from "../github/github-connection-store.js";
import type { Logger } from "../logger.js";
import type { PublicationBundleUploads } from "../publication/publication-bundle-uploads.js";
import type { ThreadWorkspaces } from "../thread-relay/thread-workspaces.js";
import type { ThreadStore } from "../threads/thread-store.js";
import { commitAuthorFor } from "./commit-author.js";
import type { RepositoryCredentials } from "./repository-credentials.js";
import type { ThreadRepositoryStore } from "./thread-repository-store.js";

export type RepositoryWorkspacesOptions = {
  threadStore: ThreadStore;
  repositories: ThreadRepositoryStore;
  connections: GithubConnectionStore;
  credentials: RepositoryCredentials;
  uploads: PublicationBundleUploads;
  logger: Logger;
};

/**
 * What a thread relay asks about its thread's workspace, answered from the
 * thread's repository: what to clone, as whom to commit, credentials to
 * read it, and bundles sent for publishing.
 */
export class RepositoryWorkspaces implements ThreadWorkspaces {
  readonly #options: RepositoryWorkspacesOptions;

  constructor(options: RepositoryWorkspacesOptions) {
    this.#options = options;
  }

  async describe(
    threadId: string,
    situation: { agentHasWorkedBefore: boolean },
  ): Promise<PrepareWorkspace> {
    const { repositories, threadStore, connections } = this.#options;
    const repository = await repositories.find(threadId);
    if (repository === undefined) {
      return { type: "prepare_workspace", repository: null, ...situation };
    }
    const ownerUserId = (await threadStore.find(threadId))?.ownerUserId ?? threadId;
    const connection = await connections.find(ownerUserId);
    return {
      type: "prepare_workspace",
      repository: {
        url: repository.url,
        access: repository.access,
        baseBranch: repository.baseBranch ?? null,
        workBranch: repository.workBranch,
        commitAuthor: commitAuthorFor(ownerUserId, connection),
      },
      ...situation,
    };
  }

  handleSupervisorRequest(
    threadId: string,
    message: SupervisorWorkspaceMessage,
    reply: (message: ControlPlaneWorkspaceMessage) => boolean,
  ): void {
    switch (message.type) {
      case "repository_credential_request":
        void this.#answerCredentialRequest(threadId, message.requestId, reply);
        return;
      case "publication_bundle_failed":
        this.#options.uploads.fail(threadId, message.publicationId, message.reason);
        return;
    }
  }

  async #answerCredentialRequest(
    threadId: string,
    requestId: string,
    reply: (message: ControlPlaneWorkspaceMessage) => boolean,
  ): Promise<void> {
    let outcome: Awaited<ReturnType<RepositoryCredentials["issue"]>>;
    try {
      outcome = await this.#options.credentials.issue(threadId);
    } catch (error) {
      this.#options.logger.error({ err: error, threadId }, "Could not answer a credential request");
      outcome = { isGranted: false, reason: "The control plane could not check access just now." };
    }
    reply({
      type: "repository_credential",
      requestId,
      outcome: outcome.isGranted
        ? {
            isGranted: true,
            username: outcome.username,
            password: outcome.password,
            expiresAt: outcome.expiresAt.toISOString(),
          }
        : { isGranted: false, reason: outcome.reason },
    });
  }
}
