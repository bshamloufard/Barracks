import { type ParseResult, threadIdSchema } from "@barrack/protocol";

/** Milestone 1 has no thread list: the thread comes from `?thread=` and defaults to `local`. */
const defaultThreadId = "local";

/**
 * Reads the thread to show from the page address's query string. A name the
 * control plane would refuse is reported here, so the page can say what is
 * wrong instead of failing to connect over and over.
 */
export function parseThreadIdFromAddress(queryString: string): ParseResult<string> {
  const threadId = new URLSearchParams(queryString).get("thread") ?? defaultThreadId;
  if (!threadIdSchema.safeParse(threadId).success) {
    return {
      ok: false,
      errorMessage:
        "The thread in the address is not valid. Use ?thread= followed by 1 to 64 letters, digits, underscores or hyphens.",
    };
  }
  return { ok: true, value: threadId };
}
