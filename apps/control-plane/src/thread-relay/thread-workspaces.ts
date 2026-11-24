import type {
  ControlPlaneWorkspaceMessage,
  PrepareWorkspace,
  SupervisorToControlPlaneMessage,
  SupervisorWorkspaceMessage,
} from "@barrack/protocol";

/**
 * What a thread relay needs to know about threads' workspaces: what to tell
 * a supervisor that has just attached, and who answers the workspace
 * requests a supervisor sends (see `workspace-messages.ts`). The relay only
 * passes these along; it holds none of the repository's rules.
 */
export interface ThreadWorkspaces {
  /** What the thread's workspace should hold, sent right after the welcome. */
  describe(
    threadId: string,
    situation: { agentHasWorkedBefore: boolean },
  ): Promise<PrepareWorkspace>;

  /**
   * Handles a request from the thread's attached supervisor; `reply` sends
   * on that same connection and returns false once it is closing.
   */
  handleSupervisorRequest(
    threadId: string,
    message: SupervisorWorkspaceMessage,
    reply: (message: ControlPlaneWorkspaceMessage) => boolean,
  ): void;

  /** Lets go of anything kept for a thread that has been deleted. */
  forgetThread(threadId: string): void;
}

/** For relays built without repositories: every workspace stays empty. */
export const emptyThreadWorkspaces: ThreadWorkspaces = {
  describe: async () => ({
    type: "prepare_workspace",
    repository: null,
    agentHasWorkedBefore: false,
  }),
  handleSupervisorRequest: (_threadId, message, reply) => {
    if (message.type === "repository_credential_request") {
      reply({
        type: "repository_credential",
        requestId: message.requestId,
        outcome: { isGranted: false, reason: "This thread has no repository." },
      });
    }
  },
  forgetThread: () => {},
};

const workspaceMessageTypes: ReadonlySet<string> = new Set<SupervisorWorkspaceMessage["type"]>([
  "repository_credential_request",
  "publication_bundle_failed",
]);

export function isSupervisorWorkspaceMessage(
  message: SupervisorToControlPlaneMessage,
): message is SupervisorWorkspaceMessage {
  return workspaceMessageTypes.has(message.type);
}
