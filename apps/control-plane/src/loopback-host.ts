import { isIPv4 } from "node:net";

/**
 * A `Host` header: a name or address, an IPv6 address in brackets, and an
 * optional port. Anything else, user information or a path included, does
 * not match. https://www.rfc-editor.org/rfc/rfc9110#section-7.2
 */
const hostHeaderPattern = /^(\[[0-9a-f:.]+\]|[^:[\]/@\s]+)(?::\d{1,5})?$/i;

/** Why a request was refused; it never quotes the `Host` that whoever sent it chose. */
export const forbiddenHostExplanation =
  "In development mode the control plane answers only requests addressed to localhost, 127.0.0.1 or [::1].";

/**
 * Whether a request was addressed to this machine's loopback interface by
 * name or address (`localhost`, `127.x.x.x` or `[::1]`, with any port), as
 * opposed to a name that merely resolves to it.
 *
 * Listening on loopback keeps other machines out, but not a web page that
 * re-points its own domain name at 127.0.0.1 (DNS rebinding): the browser
 * then treats the control plane as that page's own origin, sends no
 * `Origin` header on its GET requests, and lets it read the answers. The
 * `Host` header still carries the page's domain, which no page can change.
 * https://www.rfc-editor.org/rfc/rfc6761#section-6.3
 */
export function isAddressedToLoopback(hostHeader: string | undefined): boolean {
  const hostName = hostHeaderPattern.exec(hostHeader ?? "")?.[1]?.toLowerCase();
  if (hostName === undefined) {
    return false;
  }
  return (
    hostName === "localhost" ||
    hostName === "[::1]" ||
    (isIPv4(hostName) && hostName.startsWith("127."))
  );
}
