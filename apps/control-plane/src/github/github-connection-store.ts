/**
 * Which GitHub account each user linked, and which repositories they were
 * verified to be able to push to through the installation's App. No GitHub
 * token is ever stored: the App mints its own when needed, and the user's
 * token is discarded once the list below has been read with it.
 */
export type LinkedGithubRepository = {
  id: number;
  /** `owner/name`. */
  fullName: string;
  installationId: number;
  defaultBranch: string;
  cloneUrl: string;
  htmlUrl: string;
  isPrivate: boolean;
};

export type GithubConnectionRecord = {
  userId: string;
  githubUserId: number;
  login: string;
  /** The display name the user set on GitHub, if any. */
  name: string | undefined;
  connectedAt: Date;
  repositories: LinkedGithubRepository[];
};

/**
 * A sign-in with GitHub under way. The `state` sent to GitHub is kept only
 * as its digest; the PKCE verifier is useless without the code GitHub gives
 * the user's browser.
 */
export type GithubConnectionAttempt = {
  stateDigest: Buffer;
  userId: string;
  codeVerifier: string;
  expiresAt: Date;
};

export interface GithubConnectionStore {
  /** Records a new attempt, replacing any other attempt of the same user. */
  saveAttempt(attempt: GithubConnectionAttempt): Promise<void>;

  /**
   * Removes the attempt with this state and returns it, whoever's it is and
   * whether or not it has expired, so that a state is used at most once.
   */
  takeAttempt(stateDigest: Buffer): Promise<GithubConnectionAttempt | undefined>;

  /** Records the user's link, replacing any earlier one. */
  save(connection: GithubConnectionRecord): Promise<void>;

  find(userId: string): Promise<GithubConnectionRecord | undefined>;

  remove(userId: string): Promise<void>;
}
