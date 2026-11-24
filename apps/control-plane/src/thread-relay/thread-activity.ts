/**
 * What a thread relay tells the sandbox lifecycle before it records
 * anything, so that idle shutdown sees every message and agent event, and a
 * message can wake a stopped sandbox (`SandboxLifecycle` implements it).
 */
export interface ThreadActivity {
  /**
   * Whether a user message may be recorded; it gets the thread ready for it
   * (waking its sandbox, say) before answering yes, and says why not
   * otherwise, for the user.
   */
  admitUserMessage(
    threadId: string,
    text: string,
  ): Promise<{ isAccepted: true } | { isAccepted: false; reason: string }>;

  /** Notes that the agent did something, before its event is recorded. Never rejects. */
  recordAgentActivity(threadId: string): Promise<void>;
}
