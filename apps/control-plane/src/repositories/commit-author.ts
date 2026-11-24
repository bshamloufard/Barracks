import { createHash } from "node:crypto";
import type { CommitAuthor } from "@barrack/protocol";
import type { GithubConnectionRecord } from "../github/github-connection-store.js";

/**
 * Whom the agent's commits name as their author: the thread's user, never
 * the agent, and never an address that would publish the user's email.
 *
 * With a linked GitHub account, GitHub's own no-reply address for the user
 * (`<id>+<login>@users.noreply.github.com`), which GitHub attributes to them
 * and publishes nothing private. Without one, the sign-in only tells
 * Barrack the user's identifier (the email in the token is not known to be
 * verified, and would be published with every commit), so the author is a
 * placeholder at a domain that can never receive mail, distinct per user.
 * https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-email-preferences/setting-your-commit-email-address
 */
export function commitAuthorFor(
  userId: string,
  connection: GithubConnectionRecord | undefined,
): CommitAuthor {
  if (connection !== undefined) {
    return {
      name: sanitiseName(connection.name ?? connection.login) || connection.login,
      email: `${connection.githubUserId}+${connection.login}@users.noreply.github.com`,
    };
  }
  const userDigest = createHash("sha256").update(userId).digest("hex").slice(0, 16);
  return { name: "Barrack user", email: `user-${userDigest}@users.noreply.barrack.invalid` };
}

/** Git ends a name at `<`, and a line break would forge the commit's next header. */
function sanitiseName(name: string): string {
  return name
    .replaceAll(/[<>\n\r\0]/g, "")
    .trim()
    .slice(0, 256);
}
