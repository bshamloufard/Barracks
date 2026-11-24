import { z } from "zod";
import { maximumAccessTokenLength } from "./limits.js";

/**
 * Proves who the user is, with an access token from the sign-in service (a
 * Supabase Auth access token, or the token a control plane in development
 * mode hands out). It is the first message on every connection a client
 * opens, a thread's and a desktop viewer's, and is sent again with each
 * newer token the client receives while the connection is open, which must
 * be for the same user. When the newest token sent expires
 * without a newer one, the control plane closes the connection with
 * `closeCodes.accessTokenExpired`.
 *
 * A token never goes in the connection's URL, where it would end up in logs;
 * browsers cannot set headers on a WebSocket.
 */
export const authenticateMessageSchema = z.strictObject({
  type: z.literal("authenticate"),
  accessToken: z.string().min(1).max(maximumAccessTokenLength),
});

export type AuthenticateMessage = z.infer<typeof authenticateMessageSchema>;
