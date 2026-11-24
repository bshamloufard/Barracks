import { tmpdir } from "node:os";
import path from "node:path";
import { threadIdSchema } from "@barrack/protocol";
import { z } from "zod";

/**
 * The supervisor is configured entirely through environment variables, so a
 * sandbox provider only has to set variables to start one. Everything is
 * checked once at startup, and every problem is reported together.
 */

const absoluteDirectorySchema = z
  .string()
  .min(1)
  .transform((directory) => path.resolve(directory));

const sharedVariablesSchema = z.object({
  BARRACK_CONTROL_PLANE_URL: z
    .url({ protocol: /^wss?$/, error: "must be a ws:// or wss:// URL" })
    .transform((url) => url.replace(/\/+$/, "")),
  BARRACK_THREAD_ID: threadIdSchema,
  BARRACK_SUPERVISOR_TOKEN: z.string().min(1),
  BARRACK_SUPERVISOR_STATE_DIRECTORY: absoluteDirectorySchema,
  BARRACK_WORKSPACE_DIRECTORY: absoluteDirectorySchema.optional(),
  BARRACK_GIT_HELPER_SOCKET: absoluteDirectorySchema.optional(),
  BARRACK_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

/**
 * Linux limits a Unix socket's path to 107 bytes; a path near that is moved
 * to the temporary directory, which only happens for deep development paths.
 */
const maximumSocketPathLength = 100;

const piVariablesSchema = sharedVariablesSchema.extend({
  BARRACK_AGENT_HARNESS: z.literal("pi").default("pi"),
  BARRACK_MODEL: z
    .string()
    .regex(/^[^/\s]+\/\S+$/, 'must be "provider/model", e.g. "openai/example-model"'),
  BARRACK_WORKSPACE_DIRECTORY: absoluteDirectorySchema,
  BARRACK_STATE_DIRECTORY: absoluteDirectorySchema,
  BARRACK_AGENT_USER: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "must be the name of an operating-system user")
    .optional(),
  BARRACK_AGENT_SHARES_SUPERVISOR_USER: z
    .literal("development-only", {
      error: 'must be exactly "development-only", or unset',
    })
    .optional(),
});

const fakeVariablesSchema = sharedVariablesSchema.extend({
  BARRACK_AGENT_HARNESS: z.literal("fake"),
});

type Variables = z.infer<typeof fakeVariablesSchema> | z.infer<typeof piVariablesSchema>;

export type LogLevel = z.infer<typeof sharedVariablesSchema>["BARRACK_LOG_LEVEL"];

type SharedConfiguration = {
  controlPlaneUrl: string;
  threadId: string;
  /** Proves to the control plane that this supervisor belongs to the thread. Never logged. */
  supervisorToken: string;
  /**
   * Where the supervisor keeps what must survive its own restart (how far
   * the agent has been handed user messages). Only the supervisor's user
   * should be able to write to it.
   */
  supervisorStateDirectory: string;
  /** Where the agent works and the thread's repository is cloned; none for a fake agent without one. */
  workspaceDirectory: string | undefined;
  /**
   * The Unix socket Git's credential helper asks the supervisor on. It must
   * be somewhere the agent can reach and no one outside the sandbox can; the
   * sandbox image sets one.
   */
  gitCredentialSocketPath: string;
  logLevel: LogLevel;
};

export type PiHarnessConfiguration = {
  kind: "pi";
  /** In Pi's `provider/model` form. */
  model: string;
  workspaceDirectory: string;
  stateDirectory: string;
  /** The operating-system user Pi runs as. */
  agentUserName: string | undefined;
  /**
   * Whether Pi may run as the supervisor's own user, where it can read the
   * supervisor's token: an explicit choice, for local development only.
   */
  agentMayShareSupervisorUser: boolean;
};

export type AgentHarnessConfiguration = PiHarnessConfiguration | { kind: "fake" };

export type SupervisorConfiguration = SharedConfiguration & {
  agentHarness: AgentHarnessConfiguration;
};

export type ConfigurationResult =
  | { ok: true; configuration: SupervisorConfiguration }
  | { ok: false; problems: string[] };

export function readConfiguration(environment: NodeJS.ProcessEnv): ConfigurationResult {
  const { BARRACK_AGENT_HARNESS: harnessName } = environment;
  // Validating against the schema of the chosen harness alone keeps the error
  // list to the variables that harness actually needs.
  const schema = harnessName === "fake" ? fakeVariablesSchema : piVariablesSchema;
  const validation = schema.safeParse(environment);
  if (!validation.success) {
    return { ok: false, problems: describeProblems(validation.error, harnessName) };
  }
  return { ok: true, configuration: toConfiguration(validation.data) };
}

function toConfiguration(variables: Variables): SupervisorConfiguration {
  return {
    controlPlaneUrl: variables.BARRACK_CONTROL_PLANE_URL,
    threadId: variables.BARRACK_THREAD_ID,
    supervisorToken: variables.BARRACK_SUPERVISOR_TOKEN,
    supervisorStateDirectory: variables.BARRACK_SUPERVISOR_STATE_DIRECTORY,
    workspaceDirectory: variables.BARRACK_WORKSPACE_DIRECTORY,
    gitCredentialSocketPath:
      variables.BARRACK_GIT_HELPER_SOCKET ??
      defaultCredentialSocketPath(
        variables.BARRACK_SUPERVISOR_STATE_DIRECTORY,
        variables.BARRACK_THREAD_ID,
      ),
    logLevel: variables.BARRACK_LOG_LEVEL,
    agentHarness:
      variables.BARRACK_AGENT_HARNESS === "fake"
        ? { kind: "fake" }
        : {
            kind: "pi",
            model: variables.BARRACK_MODEL,
            workspaceDirectory: variables.BARRACK_WORKSPACE_DIRECTORY,
            stateDirectory: variables.BARRACK_STATE_DIRECTORY,
            agentUserName: variables.BARRACK_AGENT_USER,
            agentMayShareSupervisorUser:
              variables.BARRACK_AGENT_SHARES_SUPERVISOR_USER === "development-only",
          },
  };
}

/** Beside the supervisor's state, unless that path is too long for a socket. */
function defaultCredentialSocketPath(supervisorStateDirectory: string, threadId: string): string {
  const besideState = path.join(supervisorStateDirectory, "git-credential.sock");
  return besideState.length <= maximumSocketPathLength
    ? besideState
    : path.join(tmpdir(), `barrack-git-credential-${threadId}.sock`);
}

/** Names each variable and what is wrong with it, without ever echoing a value. */
function describeProblems(error: z.ZodError, harnessName: string | undefined): string[] {
  return error.issues.map((issue) => {
    const variableName = String(issue.path[0] ?? "environment");
    if (variableName === "BARRACK_AGENT_HARNESS") {
      return `BARRACK_AGENT_HARNESS: must be "pi" or "fake", got "${harnessName}"`;
    }
    const reason = issue.code === "invalid_type" ? "is required" : issue.message;
    return `${variableName}: ${reason}`;
  });
}
