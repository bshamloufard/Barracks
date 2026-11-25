/**
 * What the built web client may load and reach, derived from what it does:
 *
 * - its scripts and styles are files of its own (`vite build` writes no
 *   inline script or style into the page; React and noVNC style elements
 *   through the CSSOM, which a policy does not govern);
 * - it talks to the control plane at its own origin: HTTPS for the API, and
 *   WebSockets for each thread and its live desktop, whose `ws:`/`wss:`
 *   origins are listed as well as `'self'`, because Safari has long matched
 *   `'self'` to the page's own scheme only (WebKit bug 201591);
 * - it asks the installation's Supabase project to sign users in, at the URL
 *   the control plane hands it;
 * - noVNC draws the desktop on a canvas, decoding each JPEG or PNG rectangle
 *   through a `data:` image and showing the desktop's cursor as a `data:`
 *   image; it needs no worker, blob or frame.
 *
 * Everything else is refused, including framing the page anywhere.
 */
export type WebClientPolicySources = {
  /** The origins the client is served from, which its WebSockets connect back to. */
  allowedClientOrigins: ReadonlySet<string>;
  /** The Supabase project users sign in with, or undefined in development mode. */
  supabaseUrl: string | undefined;
};

export function describeWebClientContentSecurityPolicy(sources: WebClientPolicySources): string {
  const connectSources = [
    "'self'",
    ...[...sources.allowedClientOrigins].flatMap(toWebSocketOrigin),
    ...(sources.supabaseUrl === undefined ? [] : [new URL(sources.supabaseUrl).origin]),
  ];
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * For answers that are data, not a page (the API, `/health`): nothing may
 * load, should a browser ever be led to render one as a document.
 */
export const dataAnswerContentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'";

function toWebSocketOrigin(origin: string): string[] {
  const url = new URL(origin);
  if (url.protocol === "https:") {
    return [`wss://${url.host}`];
  }
  if (url.protocol === "http:") {
    return [`ws://${url.host}`];
  }
  return [];
}
