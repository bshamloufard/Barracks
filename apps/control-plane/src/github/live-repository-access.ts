import { type GithubApi, GithubApiError } from "./github-api.js";
import type { GithubConnectionRecord, LinkedGithubRepository } from "./github-connection-store.js";

/**
 * - `ok: true`: GitHub says the access is there now.
 * - `isCertain: true`: GitHub said it is not.
 * - `isCertain: false`: GitHub could not be asked (it was down, slow, or
 *   answered with something Barrack could not read), so nothing is known.
 */
export type LiveAccess = { ok: true } | { ok: false; reason: string; isCertain: boolean };

/** What the user must still be able to do with the repository. */
export type NeededAccess = "push" | "read";

/**
 * Asks GitHub, now, whether the user may still use the repository through
 * the App: the installation must still include it (a token for it must be
 * mintable) and the user must still be able to push to it, or read it.
 * Used when a thread is created on the repository, before every
 * publication, and before every read token a sandbox is given, since the
 * list verified when the user connected may be out of date.
 */
export async function checkLiveRepositoryAccess(
  api: GithubApi,
  connection: GithubConnectionRecord,
  repository: Pick<LinkedGithubRepository, "id" | "installationId" | "fullName">,
  needed: NeededAccess = "push",
): Promise<LiveAccess> {
  let token: string;
  try {
    ({ token } = await api.createInstallationToken(repository.installationId, repository.id, {
      metadata: "read",
    }));
  } catch (error) {
    return isDefinitiveRefusal(error)
      ? refuse(
          `Barrack's GitHub App can no longer reach ${repository.fullName}: it may have been uninstalled or had the repository removed. Install it on the repository again, then reconnect GitHub in Settings.`,
        )
      : couldNotAsk(repository.fullName);
  }
  // The token can read only the repository's metadata, never leaves the
  // control plane and expires within the hour, so it is not revoked.
  let permission: { canRead: boolean; canPush: boolean };
  try {
    permission = await api.readUserPermission(token, repository.fullName, connection.login);
  } catch (error) {
    return isDefinitiveRefusal(error)
      ? refuse(`GitHub says @${connection.login} can no longer reach ${repository.fullName}.`)
      : couldNotAsk(repository.fullName);
  }
  if (needed === "push" && !permission.canPush) {
    return refuse(`GitHub says @${connection.login} can no longer push to ${repository.fullName}.`);
  }
  if (needed === "read" && !permission.canRead) {
    return refuse(`GitHub says @${connection.login} can no longer read ${repository.fullName}.`);
  }
  return { ok: true };
}

/**
 * GitHub answering that the installation, the repository or the user is not
 * there (403, 404, 422) is an answer; anything else (no answer, a server
 * error, a rate limit, an App misconfigured) says nothing about the user.
 */
function isDefinitiveRefusal(error: unknown): boolean {
  return error instanceof GithubApiError && [403, 404, 422].includes(error.status ?? 0);
}

function refuse(reason: string): LiveAccess {
  return { ok: false, reason, isCertain: true };
}

function couldNotAsk(fullName: string): LiveAccess {
  return {
    ok: false,
    reason: `GitHub could not be asked whether ${fullName} may still be used through Barrack's App, so Barrack does not assume it may. Try again in a minute.`,
    isCertain: false,
  };
}
