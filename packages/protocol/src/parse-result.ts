/**
 * The outcome of checking something that arrived from another part of the
 * system. Parsers return this instead of throwing so that every boundary
 * handles rejection explicitly and can log why a message was refused.
 */
export type ParseResult<Value> = { ok: true; value: Value } | { ok: false; errorMessage: string };
