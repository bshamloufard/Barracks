import { githubCallbackPagePath, type ParseResult, threadIdSchema } from "@barrack/protocol";

/**
 * Which page the address shows: the thread list at `/`, one thread at
 * `/?thread={threadId}`, or the settings at `/?page=settings`. The query
 * keeps every page on the one path the control plane serves the client
 * from, so reloading any page works. The one exception is the page GitHub
 * sends the user back to, whose path the GitHub App's settings name (see
 * `parsePageLocation`).
 */
export type PageAddress =
  | { page: "thread-list" }
  | { page: "thread"; threadId: string }
  | { page: "settings" }
  | { page: "github-callback"; code: string; state: string };

const threadQueryParameter = "thread";
const pageQueryParameter = "page";

/** The page at a path and query: GitHub's callback page by its path, any other by its query. */
export function parsePageLocation(pathname: string, queryString: string): ParseResult<PageAddress> {
  if (pathname !== githubCallbackPagePath) {
    return parsePageAddress(queryString);
  }
  const query = new URLSearchParams(queryString);
  const code = query.get("code");
  const state = query.get("state");
  if (code === null || state === null) {
    return {
      ok: false,
      errorMessage:
        "GitHub sent you back without what Barrack needs to connect your account. Start again from Settings.",
    };
  }
  return { ok: true, value: { page: "github-callback", code, state } };
}

/**
 * A name the control plane could never have minted is reported here, so the
 * page can say what is wrong instead of asking the control plane about it.
 */
export function parsePageAddress(queryString: string): ParseResult<PageAddress> {
  const query = new URLSearchParams(queryString);
  if (query.get(pageQueryParameter) === "settings") {
    return { ok: true, value: { page: "settings" } };
  }
  const threadId = query.get(threadQueryParameter);
  if (threadId === null) {
    return { ok: true, value: { page: "thread-list" } };
  }
  if (!threadIdSchema.safeParse(threadId).success) {
    return {
      ok: false,
      errorMessage:
        "The thread in the address is not valid: a thread is named by 1 to 64 letters, digits, underscores or hyphens.",
    };
  }
  return { ok: true, value: { page: "thread", threadId } };
}

export function threadPageAddress(threadId: string): string {
  return `/?${new URLSearchParams({ [threadQueryParameter]: threadId }).toString()}`;
}

export const threadListAddress = "/";

export const settingsAddress = `/?${pageQueryParameter}=settings`;
