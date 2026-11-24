import { apiErrorResponseSchema } from "@barrack/protocol";
import type { AccessTokenSource } from "../authentication/sign-in-service";

/** What the page does when the control plane refuses who is signed in. */
export type AccessRefusalHandlers = {
  /** The token is not accepted even after a refresh: the user must sign in again. */
  onSignInRequired: () => void;
  /** The user is signed in, but this installation does not admit them. */
  onNotAllowed: () => void;
};

export type AuthorizedFetch = (path: string, init?: RequestInit) => Promise<Response>;

type SendRequest = (path: string, init: RequestInit) => Promise<Response>;

/**
 * Sends a request to the control plane with the signed-in user's access
 * token. A token refused as not valid (it may have expired while the tab
 * was hidden) is refreshed and the request tried once more; refused again,
 * the user must sign in again. A refusal of the user is reported, and the
 * response returned for the caller to describe.
 */
export function createAuthorizedFetch(
  accessTokens: AccessTokenSource,
  handlers: AccessRefusalHandlers,
  send: SendRequest = (path, init) => fetch(path, init),
): AuthorizedFetch {
  return async (path, init = {}) => {
    const firstToken = await accessTokens.currentAccessToken();
    const firstResponse = await sendWithToken(send, path, init, firstToken);
    const response =
      firstResponse.status === 401
        ? await sendWithToken(send, path, init, await accessTokens.refreshAccessToken())
        : firstResponse;
    if (response.status === 401) {
      handlers.onSignInRequired();
    } else if (await isRefusalOfUser(response)) {
      handlers.onNotAllowed();
    }
    return response;
  };
}

async function sendWithToken(
  send: SendRequest,
  path: string,
  init: RequestInit,
  accessToken: string | undefined,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (accessToken !== undefined) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  try {
    return await send(path, { ...init, headers });
  } catch {
    throw new Error("The control plane could not be reached. Check that it is running.");
  }
}

async function isRefusalOfUser(response: Response): Promise<boolean> {
  if (response.status !== 403) {
    return false;
  }
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  const apiError = apiErrorResponseSchema.safeParse(body);
  return apiError.success && apiError.data.error.code === "not_allowed";
}
