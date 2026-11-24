import { type ParseResult, threadIdSchema } from "@barrack/protocol";

/**
 * Which page the address shows: the thread list at `/`, or one thread at
 * `/?thread={threadId}`. The query keeps every page on the one path the
 * control plane serves the client from, so reloading any page works.
 */
export type PageAddress = { page: "thread-list" } | { page: "thread"; threadId: string };

const threadQueryParameter = "thread";

/**
 * A name the control plane could never have minted is reported here, so the
 * page can say what is wrong instead of asking the control plane about it.
 */
export function parsePageAddress(queryString: string): ParseResult<PageAddress> {
  const threadId = new URLSearchParams(queryString).get(threadQueryParameter);
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
