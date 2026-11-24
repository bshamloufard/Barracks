import { z } from "zod";
import { maximumIdentifierLength } from "./limits.js";

/**
 * Identifiers (of threads, messages and tool calls) are opaque: no part of
 * Barrack may read meaning into their format, because some are minted by
 * Barrack and others by model providers.
 */
export const identifierSchema = z.string().min(1).max(maximumIdentifierLength);
