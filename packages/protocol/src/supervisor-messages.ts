import { z } from "zod";
import { agentEventSchema } from "./agent-events.js";
import { identifierSchema } from "./identifier.js";
import { interruptAgentMessageSchema } from "./interrupt-agent-message.js";
import { parseFrame } from "./parse-frame.js";
import type { ParseResult } from "./parse-result.js";
import { streamFragmentMessageSchema } from "./stream-fragments.js";
import { userMessageTextSchema } from "./thread-events.js";

/**
 * Messages on the WebSocket between a thread's sandbox supervisor and the
 * control plane. The supervisor opens the connection; the thread it belongs
 * to is named in the connection's URL (see `buildSupervisorEndpointPath`),
 * so no message repeats it.
 */

/**
 * An event the agent caused. The control plane assigns it the thread's next
 * sequence and stores it before forwarding it to any client.
 */
export const agentEventMessageSchema = z.strictObject({
  type: z.literal("agent_event"),
  event: agentEventSchema,
});

export const supervisorToControlPlaneMessageSchema = z.discriminatedUnion("type", [
  agentEventMessageSchema,
  streamFragmentMessageSchema,
]);

/**
 * Hands the agent a message the user sent. The control plane has already
 * recorded it as a `user_message` thread event with this `messageId`. If the
 * agent is busy, the supervisor queues it for the agent to read next.
 */
export const deliverUserMessageSchema = z.strictObject({
  type: z.literal("deliver_user_message"),
  messageId: identifierSchema,
  text: userMessageTextSchema,
});

export const controlPlaneToSupervisorMessageSchema = z.discriminatedUnion("type", [
  deliverUserMessageSchema,
  interruptAgentMessageSchema,
]);

export type AgentEventMessage = z.infer<typeof agentEventMessageSchema>;
export type SupervisorToControlPlaneMessage = z.infer<typeof supervisorToControlPlaneMessageSchema>;
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
