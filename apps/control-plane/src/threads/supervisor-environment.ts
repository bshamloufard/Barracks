/** Which agent the supervisor runs; see the supervisor's README. */
export type AgentSettings = { harness: "fake" } | { harness: "pi"; model: string };

export type SupervisorEnvironmentSettings = {
  /**
   * The control plane's WebSocket base URL as a sandbox reaches it, which
   * is rarely the address it listens on: a container reaches the host as
   * `host.docker.internal`, and a cloud sandbox needs the public URL.
   */
  controlPlaneUrlForSandboxes: string;
  agent: AgentSettings;
  /** Forwarded to sandboxes running Pi; see `model-credentials.ts`. */
  modelCredentials: Readonly<Record<string, string>>;
};

/**
 * Everything a new thread's supervisor is told, as the environment variables
 * its configuration reads. The result holds the thread's token and possibly
 * model keys, so it goes to the sandbox provider and nowhere else.
 */
export function buildSupervisorEnvironment(
  settings: SupervisorEnvironmentSettings,
  threadId: string,
  supervisorToken: string,
): Record<string, string> {
  const threadVariables = {
    BARRACK_CONTROL_PLANE_URL: settings.controlPlaneUrlForSandboxes,
    BARRACK_THREAD_ID: threadId,
    BARRACK_SUPERVISOR_TOKEN: supervisorToken,
  };
  const { agent } = settings;
  if (agent.harness === "fake") {
    return { ...threadVariables, BARRACK_AGENT_HARNESS: "fake" };
  }
  return {
    ...settings.modelCredentials,
    ...threadVariables,
    BARRACK_AGENT_HARNESS: "pi",
    BARRACK_MODEL: agent.model,
  };
}
