import { z } from "zod";
import { interruptAgentMessageSchema } from "./interrupt-agent-message.js";
import { maximumErrorMessageLength } from "./limits.js";
import { parseFrame } from "./parse-frame.js";
import type { ParseResult } from "./parse-result.js";
import { sequenceSchema } from "./sequence.js";
import { streamFragmentMessageSchema } from "./stream-fragments.js";
import { recordedThreadEventSchema, userMessageTextSchema } from "./thread-events.js";

/**
 * Messages on the WebSocket between a client and the control plane. A client
 * opens one connection per thread it is viewing, naming the thread and the
 * last sequence it has already seen in the connection's URL (see
 * `buildClientEndpointPath`).
 *
 * The control plane's first message on every connection is a
 * `replay_announcement`. Exactly the announced thread events follow, in
 * sequence order, and only then does anything else arrive. A client can
 * therefore tell catching up from watching live.
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
  clientMessageRejectedSchema,
]);

/**
 * Something the user typed for the agent. The control plane mints the message
 * identifier, records a `user_message` thread event and delivers it to the
 * supervisor.
 */
export const sendUserMessageSchema = z.strictObject({
  type: z.literal("send_user_message"),
  text: userMessageTextSchema,
});

export const clientToControlPlaneMessageSchema = z.discriminatedUnion("type", [
  sendUserMessageSchema,
  interruptAgentMessageSchema,
]);

export type ReplayAnnouncement = z.infer<typeof replayAnnouncementSchema>;
export type ThreadEventMessage = z.infer<typeof threadEventMessageSchema>;
export type SupervisorConnectionStatus = z.infer<typeof supervisorConnectionStatusSchema>;
export type ClientMessageRejected = z.infer<typeof clientMessageRejectedSchema>;
export type ControlPlaneToClientMessage = z.infer<typeof controlPlaneToClientMessageSchema>;
export type SendUserMessage = z.infer<typeof sendUserMessageSchema>;
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
