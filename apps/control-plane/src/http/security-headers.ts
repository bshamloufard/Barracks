import type { Context, MiddlewareHandler } from "hono";
import { isAddressedToLoopback } from "../loopback-host.js";
import { dataAnswerContentSecurityPolicy } from "./web-client-content-security-policy.js";

/** A year: browsers keep using HTTPS for the domain that long after each visit. */
const strictTransportSecurity = "max-age=31536000";

/**
 * The headers every answer carries, the API's and the web client's alike.
 * An answer without a Content-Security-Policy of its own by then (anything
 * but the web client's files, which `sendContentSecurityPolicy` covers) is
 * given the policy for data.
 *
 * - `X-Content-Type-Options: nosniff`, so a browser never runs or styles
 *   with a file served as something else.
 * - `X-Frame-Options: DENY`, for browsers that predate `frame-ancestors`:
 *   no page may frame this one and trick a user into clicking in it.
 * - `Referrer-Policy: same-origin`: a sign-in link returns to `/?code=…`, and
 *   no request to another site (Supabase, GitHub, a link in a thread) is
 *   told the page's address. Requests to the control plane itself still
 *   are, which tells it only an address it served; `no-referrer` would hide
 *   nothing more.
 * - `Strict-Transport-Security`, only where the browser reached the
 *   installation over HTTPS (see `wasReachedOverHttps`).
 */
export function sendSecurityHeaders(): MiddlewareHandler {
  return async (context, next) => {
    await next();
    const { headers } = context.res;
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "same-origin");
    if (!headers.has("Content-Security-Policy")) {
      headers.set("Content-Security-Policy", dataAnswerContentSecurityPolicy);
    }
    if (wasReachedOverHttps(context)) {
      headers.set("Strict-Transport-Security", strictTransportSecurity);
    }
  };
}

/** Gives every answer of the routes it is mounted on this policy. */
export function sendContentSecurityPolicy(policy: string): MiddlewareHandler {
  return async (context, next) => {
    await next();
    context.res.headers.set("Content-Security-Policy", policy);
  };
}

/**
 * The control plane never terminates TLS: where it is reached over HTTPS, a
 * proxy in front of it (Railway's edge, a reverse proxy before Compose) did,
 * and says so in `X-Forwarded-Proto` (Railway's edge overwrites whatever a
 * caller sent). Anyone can send the header over plain HTTP to get the HSTS
 * header back, but browsers ignore HSTS received without TLS (RFC 6797,
 * section 8.1), so that achieves nothing. Plain HTTP itself (Compose on
 * `http://localhost:8787`, `pnpm dev` through Vite, Railway's health check,
 * which comes from inside its network) never gets it, nor does any loopback
 * name even through a proxy, so that HTTPS on `localhost` once can never
 * make a browser refuse every other development server there.
 */
function wasReachedOverHttps(context: Context): boolean {
  const forwardedProtocol = context.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  return (
    forwardedProtocol?.toLowerCase() === "https" &&
    !isAddressedToLoopback(context.req.header("host"))
  );
}
