import type { GithubApi } from "./github-api.js";
import type { GithubConnectionRecord, LinkedGithubRepository } from "./github-connection-store.js";

export type LiveAccess = { ok: true } | { ok: false; reason: string };

/**
 * Asks GitHub, now, whether the user may still use the repository through
 * the App: the installation must still include it (a token for it must be
 * mintable) and the user must still be able to push to it. Used when a
 * thread is created on the repository and before every publication, since
 * the list verified when the user connected may be out of date.
 */
export async function checkLiveRepositoryAccess(
  api: GithubApi,
  connection: GithubConnectionRecord,
  repository: Pick<LinkedGithubRepository, "id" | "installationId" | "fullName">,
): Promise<LiveAccess> {
  let token: string;
  try {
    ({ token } = await api.createInstallationToken(repository.installationId, repository.id, {
      metadata: "read",
    }));
  } catch {
    return {
      ok: false,
      reason: `Barrack's GitHub App can no longer reach ${repository.fullName}: it may have been uninstalled or had the repository removed. Install it on the repository again, then reconnect GitHub in Settings.`,
    };
  }
  // The token can read only the repository's metadata, never leaves the
  // control plane and expires within the hour, so it is not revoked.
  if (!(await api.canUserPush(token, repository.fullName, connection.login))) {
    return {
      ok: false,
      reason: `GitHub says @${connection.login} can no longer push to ${repository.fullName}.`,
    };
  }
  return { ok: true };
}
