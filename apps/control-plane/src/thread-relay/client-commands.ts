import type { ClientCommand, RecordedThreadEvent, SendUserMessage } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { ThreadEventLog } from "../thread-event-log/thread-event-log.js";
import type { ClientConnection } from "./connections.js";
import type { SupervisorAttachment } from "./supervisor-attachment.js";
import type { ThreadActivity } from "./thread-activity.js";
import type { ThreadClients } from "./thread-clients.js";
import type { ThreadModelAccess } from "./thread-model-access.js";

/*
 * What a client watching a thread may ask of it: to send a user message,
 * which is recorded once the thread's model access and its sandbox's
 * lifecycle admit it, or to interrupt the agent. The thread's relay runs
 * each command in its queue, in order with everything else it records.
 */

export type ClientCommandsOptions = {
  threadId: string;
  threadEventLog: ThreadEventLog;
  threadActivity: ThreadActivity;
  modelAccess: ThreadModelAccess;
  clients: ThreadClients;
  supervisors: SupervisorAttachment;
  /** Shows clients an event just recorded, and hands it to the supervisor. */
  broadcastRecordedEvent: (recordedEvent: RecordedThreadEvent) => Promise<void>;
  logger: Logger;
};

export class ClientCommands {
  readonly #options: ClientCommandsOptions;

  constructor(options: ClientCommandsOptions) {
    this.#options = options;
  }

  async carryOut(client: ClientConnection, command: ClientCommand): Promise<void> {
    if (command.type === "send_user_message") {
      await this.#acceptUserMessage(client, command);
      return;
    }
    this.#forwardInterrupt(client);
  }

  /**
   * Recorded whether or not an agent is connected: a message sent while the
   * thread's sandbox is starting or asleep waits in history, and clients
   * show it as waiting (see `UserMessageDeliveryStatus`), until a supervisor
   * attaches and is handed it. The sandbox lifecycle is asked first, and
   * wakes a stopped sandbox for it; it refuses only a message no agent
   * could receive, such as one to a thread being deleted.
   *
   * A message sent again with an identifier already recorded (its client
   * was told it was not saved, but it was) is not recorded again. The
   * event recorded the first time is broadcast instead, which shows it to
   * clients that were never sent it and is skipped by those that were, and
   * hands it to the supervisor if it was never handed over.
   */
  async #acceptUserMessage(client: ClientConnection, message: SendUserMessage): Promise<void> {
    const { threadId, threadEventLog, clients, logger } = this.#options;
    const { messageId, text } = message;
    try {
      const modelAdmission = await this.#options.modelAccess.admitUserMessage(threadId);
      if (!modelAdmission.isAccepted) {
        clients.reject(client, modelAdmission.reason, messageId);
        return;
      }
      const admission = await this.#options.threadActivity.admitUserMessage(threadId, text);
      if (!admission.isAccepted) {
        clients.reject(client, admission.reason, messageId);
        return;
      }
      const outcome = await threadEventLog.appendUserMessage(threadId, {
        type: "user_message",
        messageId,
        text,
      });
      if (outcome.isAlreadyRecorded) {
        logger.info(
          { messageId, sequence: outcome.recordedEvent.sequence },
          "A user message sent again was already recorded",
        );
      }
      await this.#options.broadcastRecordedEvent(outcome.recordedEvent);
    } catch (error) {
      logger.error({ err: error, messageId }, "Could not record a user message");
      clients.reject(
        client,
        "The message could not be saved, so it was not sent. Please try again.",
        messageId,
      );
      return;
    }
    if (this.#options.supervisors.session === undefined) {
      logger.info({ messageId }, "Recorded a user message to deliver once a supervisor attaches");
    }
  }

  /** Interrupts are delivered at most once; see `interruptAgentMessageSchema`. */
  #forwardInterrupt(client: ClientConnection): void {
    const { clients, logger } = this.#options;
    const session = this.#options.supervisors.session;
    if (session === undefined) {
      clients.reject(
        client,
        "No agent is connected to this thread, so there is nothing to interrupt. Messages waiting for the agent will still reach it when it connects.",
      );
      return;
    }
    const isAccepted = session.connection.send({ type: "interrupt_agent" });
    if (!isAccepted) {
      clients.reject(
        client,
        "The interrupt could not be delivered to the agent, because its connection is closing. Try again once the agent has reconnected.",
      );
      return;
    }
    logger.info("Forwarded an interrupt to the supervisor");
  }
}
