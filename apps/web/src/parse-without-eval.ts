import { config } from "zod";

/**
 * The page's Content-Security-Policy refuses `eval` and `new Function`. Zod
 * (through `@barrack/protocol`'s schemas) would otherwise try `Function("")`
 * the first time it parses an object, to see whether it may generate faster
 * parsers; the policy refuses it, which browsers report as a violation, and
 * Zod falls back to parsing without them anyway. Saying so at once skips the
 * attempt, so the page never trips the policy. Imported first by `main.tsx`.
 */
config({ jitless: true });
