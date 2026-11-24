/**
 * The token in an `Authorization: Bearer <token>` header, used by users'
 * API requests and supervisors' upgrades alike.
 * https://www.rfc-editor.org/rfc/rfc6750#section-2.1 (the scheme name is case-insensitive).
 */
export function bearerTokenFrom(authorizationHeader: string | undefined): string | undefined {
  const match = /^Bearer +(\S+)\s*$/i.exec(authorizationHeader ?? "");
  return match?.[1];
}
