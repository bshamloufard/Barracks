import { maximumRepositoryUrlLength, type ParseResult } from "@barrack/protocol";

/**
 * Which repository URLs a thread may start from. Only HTTPS: Git's other
 * transports would need keys in the sandbox (SSH), send everything in the
 * clear (`git://`), or read the sandbox's own files (`file://`, local
 * paths). A URL carrying credentials (`https://user:token@host/...`) is
 * refused too, since it would end up stored, logged and in the sandbox's
 * Git configuration.
 *
 * `allowPlainHttp` admits `http://` as well. It exists only for tests and
 * local development, whose Git servers run without TLS, and is set by
 * declaring `BARRACK_ALLOW_PLAIN_HTTP_REPOSITORIES=development-only`.
 */
export type RepositoryUrlRules = { allowPlainHttp: boolean };

export type RepositoryLocation = {
  /** The URL as stored and cloned: no trailing slash, nothing but scheme, host, port and path. */
  url: string;
  /** `https:` or, where allowed, `http:`. */
  protocol: string;
  /** The host and port, as in the URL. */
  host: string;
  /** The path's parts, decoded, none empty. */
  pathSegments: string[];
};

/** Path parts as Git hosts name them; no percent-encoding, so nothing can hide a `..` or a `/`. */
const pathSegmentPattern = /^[A-Za-z0-9._~-]+$/;

export function parseRepositoryUrl(
  text: string,
  rules: RepositoryUrlRules,
): ParseResult<RepositoryLocation> {
  if (text.length > maximumRepositoryUrlLength) {
    return refuse("is too long");
  }
  const url = URL.parse(text);
  if (url === null) {
    return refuse("is not a URL");
  }
  const allowedProtocols = rules.allowPlainHttp ? ["https:", "http:"] : ["https:"];
  if (!allowedProtocols.includes(url.protocol)) {
    return refuse("must start with https://");
  }
  if (url.username !== "" || url.password !== "") {
    return refuse("must not contain a user name or password; Barrack provides credentials itself");
  }
  if (url.search !== "" || url.hash !== "" || /[?#]/.test(text)) {
    return refuse("must not have a query or a fragment");
  }
  const pathSegments = url.pathname.replace(/\/+$/, "").split("/").slice(1);
  const hasAcceptablePath =
    pathSegments.length > 0 &&
    pathSegments.every(
      (segment) => pathSegmentPattern.test(segment) && segment !== "." && segment !== "..",
    );
  if (!hasAcceptablePath) {
    return refuse(
      "must name a repository by a path of letters, digits, '.', '_', '~' and '-', such as /owner/name",
    );
  }
  return {
    ok: true,
    value: {
      url: `${url.protocol}//${url.host}/${pathSegments.join("/")}`,
      protocol: url.protocol,
      host: url.host,
      pathSegments,
    },
  };
}

/**
 * The `owner/name` of a repository on the given GitHub, from its web or
 * clone URL (`.git` optional), or undefined if the URL is not one.
 */
export function readGithubFullName(
  location: RepositoryLocation,
  githubWebUrl: string,
): string | undefined {
  const github = new URL(githubWebUrl);
  if (location.protocol !== github.protocol || location.host !== github.host) {
    return undefined;
  }
  const [owner, name, ...rest] = location.pathSegments;
  if (owner === undefined || name === undefined || rest.length > 0) {
    return undefined;
  }
  const nameWithoutSuffix = name.endsWith(".git") ? name.slice(0, -".git".length) : name;
  return nameWithoutSuffix === "" ? undefined : `${owner}/${nameWithoutSuffix}`;
}

function refuse(reason: string): ParseResult<RepositoryLocation> {
  return { ok: false, errorMessage: `The repository URL ${reason}.` };
}
