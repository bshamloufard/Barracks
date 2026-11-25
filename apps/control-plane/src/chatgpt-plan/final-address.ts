/**
 * Reads what a user pasted back after approving a ChatGPT sign-in: the
 * address their browser ended on, `http://127.0.0.1:<port>/auth/callback?…`,
 * which fails to load, as expected, since nothing listens there. It is read
 * forgivingly, since people copy addresses in many ways: surrounding
 * spaces, quotation marks or angle brackets, the address without its
 * `http://`, or only the part from `?` on are all taken. Anything else is
 * named precisely, so the user knows what to copy instead.
 *
 * Nothing here is logged: the address holds a one-time code.
 */

/** Where the programme sends the browser; only the port may vary (developers.openai.com/siwc). */
export const callbackHost = "127.0.0.1";
export const callbackPath = "/auth/callback";

export type FinalAddressReading =
  | {
      kind: "approved";
      code: string;
      state: string;
      /** The issued client, which the programme adds on a first registration. */
      clientId: string | undefined;
      scopes: readonly string[] | undefined;
    }
  | { kind: "declined"; state: string | undefined }
  | {
      kind: "refused_by_openai";
      error: string;
      description: string | undefined;
      state: string | undefined;
    }
  | { kind: "unreadable"; problem: FinalAddressProblem };

/**
 * - `empty`: nothing was pasted.
 * - `not_an_address`: what was pasted is no address at all.
 * - `authorization_page`: the address of OpenAI's page, copied before
 *   approving, rather than the one the browser ended on.
 * - `elsewhere`: an address, but not the sign-in's callback.
 * - `cut_short`: the callback, without the code or state it must carry.
 */
export type FinalAddressProblem =
  | "empty"
  | "not_an_address"
  | "authorization_page"
  | "elsewhere"
  | "cut_short";

const wrappingCharacters = /^[\s"'<>`]+|[\s"'<>`]+$/g;

export function readFinalAddress(pasted: string): FinalAddressReading {
  const text = pasted.replace(wrappingCharacters, "");
  if (text === "") {
    return unreadable("empty");
  }
  const url = parseLeniently(text);
  if (url === undefined) {
    return unreadable("not_an_address");
  }
  if (url.pathname.endsWith("/authorize") || url.searchParams.has("code_challenge")) {
    return unreadable("authorization_page");
  }
  const isCallback =
    url.protocol === "http:" && url.hostname === callbackHost && url.pathname === callbackPath;
  const isQueryAlone = url.hostname === queryAloneHost;
  if (!isCallback && !isQueryAlone) {
    return unreadable("elsewhere");
  }
  return readCallbackParameters(url.searchParams);
}

function readCallbackParameters(parameters: URLSearchParams): FinalAddressReading {
  const state = parameters.get("state") ?? undefined;
  const error = parameters.get("error");
  if (error === "access_denied") {
    return { kind: "declined", state };
  }
  if (error !== null) {
    return {
      kind: "refused_by_openai",
      error: error.slice(0, 128),
      description: parameters.get("error_description")?.slice(0, 512),
      state,
    };
  }
  const code = parameters.get("code");
  if (code === null || code === "" || state === undefined || state === "") {
    return unreadable("cut_short");
  }
  return {
    kind: "approved",
    code,
    state,
    clientId: parameters.get("client_id") ?? undefined,
    scopes: parameters
      .get("scope")
      ?.split(" ")
      .filter((scope) => scope !== ""),
  };
}

/** Stands for no host at all, for text that is only the address's query. */
const queryAloneHost = "query-alone.invalid";

function parseLeniently(text: string): URL | undefined {
  if (text.startsWith("?") || /^(code|state|error|scope|client_id)=/.test(text)) {
    return new URL(`http://${queryAloneHost}/${text.startsWith("?") ? text : `?${text}`}`);
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  if (!URL.canParse(withScheme)) {
    return undefined;
  }
  const url = new URL(withScheme);
  return url.hostname.includes(".") || url.hostname === "localhost" ? url : undefined;
}

function unreadable(problem: FinalAddressProblem): FinalAddressReading {
  return { kind: "unreadable", problem };
}
