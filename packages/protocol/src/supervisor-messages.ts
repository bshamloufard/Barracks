import { z } from "zod";
import { agentEventSchema } from "./agent-events.js";
import {
  controlPlaneDesktopMessageSchema,
  supervisorDesktopMessageSchema,
} from "./desktop-messages.js";
import { identifierSchema } from "./identifier.js";
import { interruptAgentMessageSchema } from "./interrupt-agent-message.js";
import { configureModelAccessSchema } from "./model-access.js";
import { parseFrame } from "./parse-frame.js";
import type { ParseResult } from "./parse-result.js";
import { workspaceEventSchema } from "./repository-events.js";
import { sequenceSchema } from "./sequence.js";
import { streamFragmentMessageSchema } from "./stream-fragments.js";
import { userMessageTextSchema } from "./thread-events.js";
import {
  controlPlaneWorkspaceMessageSchema,
  supervisorWorkspaceMessageSchema,
} from "./workspace-messages.js";

/**
 * Messages on the WebSocket between a thread's sandbox supervisor and the
 * control plane. The supervisor opens the connection; the thread it belongs
 * to is named in the connection's URL (see `buildSupervisorEndpointPath`),
 * so no message repeats it.
 *
 * Delivery is acknowledged in both directions, so nothing durable is lost
 * when a connection dies, half-open or not, or when either side restarts.
 * Stream fragments are the exception: they stay best-effort and unnumbered.
 *
 * The handshake, on every connection, which the control plane has accepted
 * only with the token minted for the thread named in its URL:
 * 1. The supervisor sends `supervisor_hello`, and nothing else until it is
 *    answered. It names its instance (a fresh identifier each time its
 *    process starts) and how far it has handed user messages to the agent.
 * 2. If the thread's history shows a run that a different, earlier
 *    supervisor instance started and never ended, nobody can end it any
 *    more, so the control plane records `agent_failed` to close it.
 * 3. The control plane answers `supervisor_welcome` with the number of the
 *    last of this instance's agent events it has recorded. The supervisor
 *    forgets those and sends every later one again, in order.
 * 4. The control plane sends every recorded user message the agent has not
 *    yet been handed, in order, and then each new one as it is recorded.
 *
 * A thread has one supervisor at a time: the newest connection to say hello
 * wins, and the one it replaces is closed with
 * `closeCodes.supersededByNewerSupervisor` and must not reconnect. Anything
 * else sent before the hello, or a claim the thread's history contradicts,
 * closes the connection with `closeCodes.invalidMessage`.
 *
 * Agent events, supervisor to control plane: each carries an `eventNumber`,
 * 1 for an instance's first and one more for each later one. The control
 * plane records an event once per instance and number (the thread event
 * log enforces it, so a resent or duplicated event is never recorded
 * twice), records them in number order, and answers
 * `agent_events_recorded` once an event is durable. Only then may the
 * supervisor forget it.
 *
 * User messages, control plane to supervisor: each carries its thread
 * sequence. The supervisor notes on its own disk that it is handing a
 * message to the agent before it does, ignores any message at or before
 * that point (a redelivery), and answers `user_messages_delivered`, which
 * the control plane stores so that a supervisor starting afresh is not
 * handed messages an earlier one already gave the agent.
 *
 * Interrupts are not acknowledged or resent: one that arrived late would
 * stop whatever the agent was doing by then, which the user never asked for.
 *
 * The workspace's messages (cloning, credentials, publishing) are described
 * in `workspace-messages.ts`; `prepare_workspace` follows the welcome. Then
 * `configure_model_access` (in `model-access.ts`) tells the supervisor the
 * thread's model and its owner's credential for it, before any user
 * message, and again whenever either changes.
 *
 * The desktop's messages (`desktop-messages.ts`) travel here too, unnumbered
 * like the workspace's: after the welcome the control plane says who holds
 * the desktop's input (`desktop_control`) and the supervisor whether it has
 * a desktop (`desktop_availability`); and each viewer's stream is asked for
 * here (`open_desktop_stream`) but carried on a WebSocket of its own.
 */

/**
 * What a supervisor reports as numbered events: the agent's, and its own
 * about preparing the workspace.
 */
export const supervisorEventSchema = z.discriminatedUnion("type", [
  ...agentEventSchema.options,
  ...workspaceEventSchema.options,
]);

/**
 * Opens every connection. `userMessagesDeliveredThroughSequence` is the
 * sequence of the last user message this supervisor's sandbox has handed to
 * the agent, or 0 for none; it survives the supervisor restarting. It may
 * not exceed the thread's newest sequence.
 */
export const supervisorHelloSchema = z.strictObject({
  type: z.literal("supervisor_hello"),
  supervisorInstanceId: identifierSchema,
  userMessagesDeliveredThroughSequence: z.int().nonnegative(),
});

/**
 * An event the agent caused. `eventNumber` places it among the events of
 * the supervisor instance that sent it (see the handshake above). The
 * control plane assigns it the thread's next sequence and stores it before
 * forwarding it to any client.
 */
export const agentEventMessageSchema = z.strictObject({
  type: z.literal("agent_event"),
  eventNumber: z.int().positive(),
  event: supervisorEventSchema,
});

/** Every user message up to and including this thread sequence has been handed to the agent. */
export const userMessagesDeliveredSchema = z.strictObject({
  type: z.literal("user_messages_delivered"),
  throughSequence: sequenceSchema,
});

export const supervisorToControlPlaneMessageSchema = z.discriminatedUnion("type", [
  supervisorHelloSchema,
  agentEventMessageSchema,
  streamFragmentMessageSchema,
  userMessagesDeliveredSchema,
  ...supervisorWorkspaceMessageSchema.options,
  ...supervisorDesktopMessageSchema.options,
]);

/**
 * Answers `supervisor_hello`. Every event of the supervisor's instance up
 * to and including `lastRecordedEventNumber` is recorded (0 when none is);
 * the supervisor sends the rest again.
 */
export const supervisorWelcomeSchema = z.strictObject({
  type: z.literal("supervisor_welcome"),
  lastRecordedEventNumber: z.int().nonnegative(),
});

/** Every agent event of this connection's instance up to and including this number is recorded. */
export const agentEventsRecordedSchema = z.strictObject({
  type: z.literal("agent_events_recorded"),
  throughEventNumber: z.int().positive(),
});

/**
 * Hands the agent a message the user sent. The control plane has already
 * recorded it as a `user_message` thread event with this `sequence` and
 * `messageId`, and sends user messages in sequence order. The same message
 * can arrive more than once, after a reconnection; the supervisor gives it
 * to the agent only the first time. If the agent is busy, it takes the
 * message up next.
 */
export const deliverUserMessageSchema = z.strictObject({
  type: z.literal("deliver_user_message"),
  sequence: sequenceSchema,
  messageId: identifierSchema,
  text: userMessageTextSchema,
});

export const controlPlaneToSupervisorMessageSchema = z.discriminatedUnion("type", [
  supervisorWelcomeSchema,
  agentEventsRecordedSchema,
  deliverUserMessageSchema,
  interruptAgentMessageSchema,
  configureModelAccessSchema,
  ...controlPlaneWorkspaceMessageSchema.options,
  ...controlPlaneDesktopMessageSchema.options,
]);

export type SupervisorEvent = z.infer<typeof supervisorEventSchema>;
export type SupervisorHello = z.infer<typeof supervisorHelloSchema>;
export type AgentEventMessage = z.infer<typeof agentEventMessageSchema>;
export type UserMessagesDelivered = z.infer<typeof userMessagesDeliveredSchema>;
export type SupervisorToControlPlaneMessage = z.infer<typeof supervisorToControlPlaneMessageSchema>;
export type SupervisorWelcome = z.infer<typeof supervisorWelcomeSchema>;
export type AgentEventsRecorded = z.infer<typeof agentEventsRecordedSchema>;
export type DeliverUserMessage = z.infer<typeof deliverUserMessageSchema>;
export type ControlPlaneToSupervisorMessage = z.infer<typeof controlPlaneToSupervisorMessageSchema>;

export function parseSupervisorToControlPlaneMessage(
  frameText: string,
): ParseResult<SupervisorToControlPlaneMessage> {
  return parseFrame(supervisorToControlPlaneMessageSchema, frameText);
}

export function parseControlPlaneToSupervisorMessage(
  frameText: string,
): ParseResult<ControlPlaneToSupervisorMessage> {
  return parseFrame(controlPlaneToSupervisorMessageSchema, frameText);
}
