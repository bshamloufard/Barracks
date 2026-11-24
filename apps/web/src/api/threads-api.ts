import {
  apiErrorResponseSchema,
  buildThreadApiPath,
  type ThreadSummary,
  threadListResponseSchema,
  threadResponseSchema,
  threadsApiPath,
} from "@barrack/protocol";
import type { AuthorizedFetch } from "./authorized-fetch";

/**
 * The control plane's threads API, at the page's own origin (through Vite's
 * proxy in development), as the signed-in user, who sees only their own
 * threads. Every answer is checked against the protocol, and every failure
 * becomes an error whose message can be shown to the user.
 */
export class ThreadsApi {
  readonly #request: AuthorizedFetch;

  constructor(request: AuthorizedFetch) {
    this.#request = request;
  }

  async listThreads(): Promise<ThreadSummary[]> {
    const response = await this.#request(threadsApiPath);
    if (!response.ok) {
      throw await describeFailure(response, "list the threads");
    }
    return parseAnswer(threadListResponseSchema, await response.json(), "list the threads").threads;
  }

  /** The thread, or undefined if the user has no such thread. */
  async fetchThread(threadId: string): Promise<ThreadSummary | undefined> {
    const response = await this.#request(buildThreadApiPath(threadId));
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw await describeFailure(response, "load the thread");
    }
    return parseAnswer(threadResponseSchema, await response.json(), "load the thread").thread;
  }

  async createThread(): Promise<ThreadSummary> {
    const response = await this.#request(threadsApiPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      throw await describeFailure(response, "create a thread");
    }
    return parseAnswer(threadResponseSchema, await response.json(), "create a thread").thread;
  }
}

type AnswerSchema<Answer> = {
  safeParse(value: unknown): { success: true; data: Answer } | { success: false };
};

function parseAnswer<Answer>(schema: AnswerSchema<Answer>, body: unknown, attempt: string): Answer {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `Could not ${attempt}: the control plane answered in a way this page does not understand. Reload the page.`,
    );
  }
  return parsed.data;
}

/** Uses the control plane's own message when it sent one in the API's error shape. */
async function describeFailure(response: Response, attempt: string): Promise<Error> {
  const body: unknown = await response.json().catch(() => undefined);
  const apiError = apiErrorResponseSchema.safeParse(body);
  const explanation = apiError.success ? apiError.data.error.message : `HTTP ${response.status}`;
  return new Error(`Could not ${attempt}: ${explanation}`);
}
