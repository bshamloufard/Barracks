/**
 * Upper bounds on the size of protocol messages and of the fields where an
 * unbounded value would be a hazard. Everything a sandbox sends is untrusted,
 * and every field ends up stored and broadcast to each viewer of a thread, so
 * a single oversized value costs memory and bandwidth many times over.
 *
 * Lengths are JavaScript string lengths (UTF-16 code units), because that is
 * what can be checked cheaply on a decoded frame.
 */

/**
 * Applies to the raw text of every WebSocket frame, so it also bounds the
 * fields below that have no limit of their own, such as assistant text and
 * tool arguments. Those are produced by the model and are already limited by
 * the provider's output-token cap; 4 Mi characters leaves room for the largest
 * current caps while keeping one frame well within a server's memory.
 */
export const maximumFrameLength = 4 * 1024 * 1024;

/**
 * Identifiers are stored, indexed and compared. Barrack mints UUIDs (36
 * characters), but tool call identifiers come from model providers, and some
 * join two provider identifiers into one, so the bound is generous.
 */
export const maximumIdentifierLength = 256;

/** Tool names are short labels chosen by tool authors and shown in the conversation view. */
export const maximumToolNameLength = 256;

/**
 * Large inputs belong in files in the workspace rather than in a chat message.
 * 100,000 characters is roughly 25,000 tokens, more than any pasted log or
 * stack trace needs.
 */
export const maximumUserMessageLength = 100_000;

/**
 * Tool output makes up most of a thread's stored bytes (OpenHands measured
 * 78%), so the supervisor truncates longer output to this length and records
 * the original size. 64 Ki characters keeps ordinary command output intact
 * while capping the outliers, such as whole files and build logs.
 */
export const maximumToolOutputLength = 64 * 1024;

/**
 * Error messages are shown to the user. Provider errors often embed the
 * provider's JSON response body, which is a few kilobytes at most.
 */
export const maximumErrorMessageLength = 16 * 1024;
