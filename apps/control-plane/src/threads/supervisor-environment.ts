/**
 * Which agent the supervisor runs; see the supervisor's README. The model
 * and its key are not here: each thread has its own, sent to its
 * supervisor over its connection, never put in the sandbox's environment.
 */
export type AgentSettings = { harness: "fake" | "pi" };

export type SupervisorEnvironmentSettings = {
  /**
   * The control plane's WebSocket base URL as a sandbox reaches it, which
   * is rarely the address it listens on: a container reaches the host as
   * `host.docker.internal`, and a cloud sandbox needs the public URL.
   */
  controlPlaneUrlForSandboxes: string;
  agent: AgentSettings;
  /** Forwarded to sandboxes running Pi; see `pi-settings.ts`. */
  piSettings: Readonly<Record<string, string>>;
};

/**
 * Everything a new thread's supervisor is told, in the two forms a sandbox
 * provider takes: plain settings, as the environment variables the
 * supervisor's configuration reads, which every process in the sandbox can
 * see; and secrets, which the provider hands the supervisor's user alone.
 * The only secret is the thread's token, so the result goes to the sandbox
 * provider and nowhere else.
 */
export function buildSupervisorEnvironment(
  settings: SupervisorEnvironmentSettings,
  threadId: string,
  supervisorToken: string,
): {
  supervisorEnvironment: Record<string, string>;
  supervisorSecrets: Record<string, string>;
} {
  const threadVariables = {
    BARRACK_CONTROL_PLANE_URL: settings.controlPlaneUrlForSandboxes,
    BARRACK_THREAD_ID: threadId,
  };
  const supervisorSecrets = buildSupervisorSecrets(supervisorToken);
  const { agent } = settings;
  if (agent.harness === "fake") {
    return {
      supervisorEnvironment: { ...threadVariables, BARRACK_AGENT_HARNESS: "fake" },
      supervisorSecrets,
    };
  }
  return {
    supervisorEnvironment: {
      ...settings.piSettings,
      ...threadVariables,
      BARRACK_AGENT_HARNESS: "pi",
    },
    supervisorSecrets,
  };
}

/** The secrets a supervisor is handed, named as it reads them. */
export function buildSupervisorSecrets(supervisorToken: string): Record<string, string> {
  return { BARRACK_SUPERVISOR_TOKEN: supervisorToken };
}
