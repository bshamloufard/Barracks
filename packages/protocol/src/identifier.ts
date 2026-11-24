import { z } from "zod";
import { maximumIdentifierLength } from "./limits.js";

/**
 * Identifiers of messages and tool calls are opaque: no part of Barrack may
 * read meaning into their format, because some are minted by Barrack and
 * others by model providers.
 */
export const identifierSchema = z.string().min(1).max(maximumIdentifierLength);

/**
 * Thread identifiers are always minted by Barrack, and they end up in URL
 * paths and in file names inside sandboxes. They are therefore limited to
 * characters that need no escaping in either place, which rules out path
 * separators and anything else a file system might interpret.
 */
export const threadIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
