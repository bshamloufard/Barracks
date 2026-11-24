import {
  apiErrorResponseSchema,
  buildPublishThreadApiPath,
  type GithubConnection,
  githubConnectionApiPath,
  githubConnectionAttemptsApiPath,
  githubConnectionResponseSchema,
  type PublishThreadResponse,
  publishThreadResponseSchema,
  startGithubConnectionResponseSchema,
} from "@barrack/protocol";
import type { AuthorizedFetch } from "./authorized-fetch";

/**
 * The control plane's API for the user's GitHub link and for publishing a
 * thread's branch. Every answer is checked against the protocol, and every
 * failure becomes an error whose message can be shown to the user.
 */
export class RepositoriesApi {
  readonly #request: AuthorizedFetch;

  constructor(request: AuthorizedFetch) {
    this.#request = request;
  }

  async readGithubConnection(): Promise<GithubConnection> {
    const response = await this.#request(githubConnectionApiPath);
    return this.#readConnection(response, "read your GitHub connection");
  }

  /** The GitHub address to send the user to, to approve Barrack's App. */
  async startConnectingGithub(): Promise<string> {
    const response = await this.#request(githubConnectionAttemptsApiPath, jsonPost({}));
    if (!response.ok) {
      throw await describeFailure(response, "start connecting GitHub");
    }
    const answer = startGithubConnectionResponseSchema.safeParse(await response.json());
    if (!answer.success) {
      throw misunderstood("start connecting GitHub");
    }
    return answer.data.authorizationUrl;
  }

  /** Hands the control plane what GitHub put in this page's address. */
  async finishConnectingGithub(code: string, state: string): Promise<GithubConnection> {
    const response = await this.#request(githubConnectionApiPath, jsonPost({ code, state }));
    return this.#readConnection(response, "connect GitHub");
  }

  async disconnectGithub(): Promise<GithubConnection> {
    const response = await this.#request(githubConnectionApiPath, { method: "DELETE" });
    return this.#readConnection(response, "disconnect GitHub");
  }

  async publishThread(threadId: string, openPullRequest: boolean): Promise<PublishThreadResponse> {
    const attempt = openPullRequest ? "open a pull request" : "push the branch";
    const response = await this.#request(
      buildPublishThreadApiPath(threadId),
      jsonPost({ openPullRequest }),
    );
    if (!response.ok) {
      throw await describeFailure(response, attempt);
    }
    const answer = publishThreadResponseSchema.safeParse(await response.json());
    if (!answer.success) {
      throw misunderstood(attempt);
    }
    return answer.data;
  }

  async #readConnection(response: Response, attempt: string): Promise<GithubConnection> {
    if (!response.ok) {
      throw await describeFailure(response, attempt);
    }
    const answer = githubConnectionResponseSchema.safeParse(await response.json());
    if (!answer.success) {
      throw misunderstood(attempt);
    }
    return answer.data.connection;
  }
}

function jsonPost(body: object): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function misunderstood(attempt: string): Error {
  return new Error(
    `Could not ${attempt}: the control plane answered in a way this page does not understand. Reload the page.`,
  );
}

async function describeFailure(response: Response, attempt: string): Promise<Error> {
  const body: unknown = await response.json().catch(() => undefined);
  const apiError = apiErrorResponseSchema.safeParse(body);
  const explanation = apiError.success ? apiError.data.error.message : `HTTP ${response.status}`;
  return new Error(`Could not ${attempt}: ${explanation}`);
}
