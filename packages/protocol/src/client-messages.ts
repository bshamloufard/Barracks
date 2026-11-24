import { z } from "zod";
import { interruptAgentMessageSchema } from "./interrupt-agent-message.js";
import { maximumAccessTokenLength, maximumErrorMessageLength } from "./limits.js";
import { parseFrame } from "./parse-frame.js";
import type { ParseResult } from "./parse-result.js";
import { sequenceSchema } from "./sequence.js";
import { streamFragmentMessageSchema } from "./stream-fragments.js";
import {
  recordedThreadEventSchema,
  type ThreadEvent,
  userMessageTextSchema,
} from "./thread-events.js";
import { userMessageDeliveryStatusSchema } from "./user-message-delivery-status.js";

/**
 * Messages on the WebSocket between a client and the control plane. A client
 * opens one connection per thread it is viewing, naming the thread and the
 * last sequence it has already seen in the connection's URL (see
 * `buildClientEndpointPath`).
 *
 * The client's first message must be `authenticate`, and it sends nothing
 * else until the replay announcement arrives. Until the control plane has
 * checked the token and that the thread is the user's own, it sends nothing
 * about the thread; a connection that sends anything else first, or nothing
 * in time, is closed (see `closeCodes`).
 *
 * Once the client is authenticated and found to own the thread, the control
 * plane sends, in this order:
 * 1. a `replay_announcement`;
 * 2. exactly the announced thread events, in sequence order;
 * 3. any thread events recorded during the replay, and any rejection of a
 *    message the client sent meanwhile;
 * 4. the current `supervisor_connection_status`;
 * 5. the current `user_message_delivery_status`;
 * 6. the text streamed so far of an assistant message still in progress;
 * and from then on live traffic, as it happens. A client can therefore tell
 * catching up from watching live, and the two statuses describe the thread
 * as of the end of its replay.
 */

/**
 * Announces the inclusive range of sequences about to be replayed: every
 * thread event after the client's last seen sequence, up to the newest one
 * stored. When the client has missed nothing, the range is empty and
 * `lastSequence` is `firstSequence - 1`.
 *
 * A client can claim a last seen sequence newer than anything the control
 * plane holds, for example after the control plane lost its history in a
 * restart. The control plane then replays the thread from sequence 1, so
 * the announcement starts at or before the client's last seen sequence. A
 * client receiving such an announcement must discard every thread event it
 * holds and rebuild from the replay, because what it held is no longer the
 * thread's history.
 */
export const replayAnnouncementSchema = z
  .strictObject({
    type: z.literal("replay_announcement"),
    firstSequence: sequenceSchema,
    lastSequence: z.int().nonnegative(),
  })
  .refine((announcement) => announcement.lastSequence >= announcement.firstSequence - 1, {
    message: "lastSequence must be at least firstSequence - 1",
    path: ["lastSequence"],
  });

/** A stored thread event, sent during replay and then live as each new one is stored. */
export const threadEventMessageSchema = recordedThreadEventSchema.extend({
  type: z.literal("thread_event"),
});

/**
 * `Date.prototype.toISOString` writes every date from year 0 to 9999 in
 * exactly this many characters.
 */
const recordedAtLength = "2026-11-24T09:00:00.000Z".length;

/**
 * The length of the frame that carries `event` to a client, with the longest
 * envelope it can ever have, so it can be checked before the event is
 * recorded and its sequence known.
 */
export function measureLargestThreadEventFrame(event: ThreadEvent): number {
  const message: ThreadEventMessage = {
    type: "thread_event",
    sequence: Number.MAX_SAFE_INTEGER,
    recordedAt: "0".repeat(recordedAtLength),
    event,
  };
  return JSON.stringify(message).length;
}

/**
 * Whether the thread's supervisor is connected to the control plane right
 * now. Sent after the replay and again whenever it changes.
 */
export const supervisorConnectionStatusSchema = z.strictObject({
  type: z.literal("supervisor_connection_status"),
  isSupervisorConnected: z.boolean(),
});

/** The control plane refused a message from this client, and says why. */
export const clientMessageRejectedSchema = z.strictObject({
  type: z.literal("client_message_rejected"),
  reason: z.string().min(1).max(maximumErrorMessageLength),
});

export const controlPlaneToClientMessageSchema = z.discriminatedUnion("type", [
  replayAnnouncementSchema,
  threadEventMessageSchema,
  streamFragmentMessageSchema,
  supervisorConnectionStatusSchema,
  userMessageDeliveryStatusSchema,
  clientMessageRejectedSchema,
]);

/**
 * Something the user typed for the agent. The control plane mints the message
 * identifier, records a `user_message` thread event and delivers it to the
 * supervisor, at once if one is connected and otherwise once one connects
 * (see `UserMessageDeliveryStatus`). It is accepted either way.
 */
export const sendUserMessageSchema = z.strictObject({
  type: z.literal("send_user_message"),
  text: userMessageTextSchema,
});

/**
 * Proves who the user is, with an access token from the sign-in service (a
 * Supabase Auth access token, or the token a control plane in development
 * mode hands out). It is the first message on every connection, and is sent
 * again with each newer token the client receives while the connection is
 * open, which must be for the same user. When the newest token sent expires
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

/** What an authenticated client asks of the thread it is viewing. */
export const clientCommandSchema = z.discriminatedUnion("type", [
  sendUserMessageSchema,
  interruptAgentMessageSchema,
]);

export const clientToControlPlaneMessageSchema = z.discriminatedUnion("type", [
  authenticateMessageSchema,
  sendUserMessageSchema,
  interruptAgentMessageSchema,
]);

export type ReplayAnnouncement = z.infer<typeof replayAnnouncementSchema>;
export type ThreadEventMessage = z.infer<typeof threadEventMessageSchema>;
export type SupervisorConnectionStatus = z.infer<typeof supervisorConnectionStatusSchema>;
export type ClientMessageRejected = z.infer<typeof clientMessageRejectedSchema>;
export type ControlPlaneToClientMessage = z.infer<typeof controlPlaneToClientMessageSchema>;
export type SendUserMessage = z.infer<typeof sendUserMessageSchema>;
export type AuthenticateMessage = z.infer<typeof authenticateMessageSchema>;
export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type ClientToControlPlaneMessage = z.infer<typeof clientToControlPlaneMessageSchema>;

export function parseControlPlaneToClientMessage(
  frameText: string,
): ParseResult<ControlPlaneToClientMessage> {
  return parseFrame(controlPlaneToClientMessageSchema, frameText);
}

export function parseClientToControlPlaneMessage(
  frameText: string,
): ParseResult<ClientToControlPlaneMessage> {
  return parseFrame(clientToControlPlaneMessageSchema, frameText);
}
