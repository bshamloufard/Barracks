import { GithubApi } from "../github/github-api.js";
import type { GithubConnectionStore } from "../github/github-connection-store.js";
import { GithubConnections } from "../github/github-connections.js";
import type { GithubSettings } from "../github/github-settings.js";
import type { Logger } from "../logger.js";
import type { GitChildLimits } from "../publication/git-child-limits.js";
import { PublicationBundleUploads } from "../publication/publication-bundle-uploads.js";
import { type PublicationChannel, ThreadPublisher } from "../publication/thread-publisher.js";
import type { Clock } from "../sandbox-lifecycle/lifecycle-settings.js";
import type { ThreadStore } from "../threads/thread-store.js";
import { type CredentialRequestLimits, RepositoryCredentials } from "./repository-credentials.js";
import { RepositoryRequests } from "./repository-requests.js";
import { RepositoryWorkspaces } from "./repository-workspaces.js";
import type { ThreadRepositoryStore } from "./thread-repository-store.js";

export type RepositoryServicesOptions = {
  threadStore: ThreadStore;
  repositories: ThreadRepositoryStore;
  connections: GithubConnectionStore;
  github: GithubSettings;
  logger: Logger;
  clock?: Clock;
  credentialRequestLimits?: CredentialRequestLimits;
  maximumBundleSizeInBytes?: number;
  gitChildLimits?: GitChildLimits;
};

/**
 * Everything about threads' repositories and GitHub: the workspaces thread
 * relays describe to supervisors, users' GitHub links, deciding which
 * repositories a thread may start from, and publishing. The publisher needs
 * the thread relays, which need the workspaces, so it is made afterwards
 * through `createPublisher`.
 */
export type RepositoryServices = {
  settings: GithubSettings;
  repositories: ThreadRepositoryStore;
  githubConnections: GithubConnections;
  requests: RepositoryRequests;
  credentials: RepositoryCredentials;
  uploads: PublicationBundleUploads;
  workspaces: RepositoryWorkspaces;
  createPublisher(channel: PublicationChannel): ThreadPublisher;
};

export function assembleRepositoryServices(options: RepositoryServicesOptions): RepositoryServices {
  const { threadStore, repositories, connections, github, logger } = options;
  const clock = options.clock ?? (() => new Date());
  const api =
    github.app === undefined
      ? undefined
      : new GithubApi({ app: github.app, webUrl: github.webUrl, apiUrl: github.apiUrl });
  const uploads = new PublicationBundleUploads();
  const credentials = new RepositoryCredentials({
    threadStore,
    repositories,
    connections,
    api,
    clock,
    logger,
    ...(options.credentialRequestLimits === undefined
      ? {}
      : { limits: options.credentialRequestLimits }),
  });
  return {
    settings: github,
    repositories,
    githubConnections: new GithubConnections({
      settings: github,
      api,
      store: connections,
      clock,
      logger,
    }),
    requests: new RepositoryRequests({ settings: github, api, connections }),
    credentials,
    uploads,
    workspaces: new RepositoryWorkspaces({
      threadStore,
      repositories,
      connections,
      credentials,
      uploads,
      logger,
    }),
    createPublisher: (channel) =>
      new ThreadPublisher({
        threadStore,
        repositories,
        connections,
        settings: github,
        api,
        uploads,
        channel,
        logger,
        ...(options.maximumBundleSizeInBytes === undefined
          ? {}
          : { maximumBundleSizeInBytes: options.maximumBundleSizeInBytes }),
        ...(options.gitChildLimits === undefined ? {} : { gitChildLimits: options.gitChildLimits }),
      }),
  };
}
