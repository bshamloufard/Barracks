import { tmpdir } from "node:os";
import path from "node:path";
import { threadIdSchema } from "@barrack/protocol";
import { z } from "zod";

/**
 * The supervisor is configured entirely through environment variables, so a
 * sandbox provider only has to set variables to start one. Everything is
 * checked once at startup, and every problem is reported together.
 */

const absolutePathSchema = z
  .string()
  .min(1)
  .transform((givenPath) => path.resolve(givenPath));

const sharedVariablesSchema = z.object({
  BARRACK_CONTROL_PLANE_URL: z
    .url({ protocol: /^wss?$/, error: "must be a ws:// or wss:// URL" })
    .transform((url) => url.replace(/\/+$/, "")),
  BARRACK_THREAD_ID: threadIdSchema,
  BARRACK_SUPERVISOR_TOKEN: z.string().min(1),
  BARRACK_SUPERVISOR_STATE_DIRECTORY: absolutePathSchema,
  BARRACK_WORKSPACE_DIRECTORY: absolutePathSchema.optional(),
  BARRACK_GIT_HELPER_SOCKET: absolutePathSchema.optional(),
  BARRACK_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  BARRACK_DESKTOP_COMMAND: absolutePathSchema.optional(),
  BARRACK_DESKTOP_VNC_PORT: z.coerce.number().int().min(1).max(65_535).default(5900),
  BARRACK_DESKTOP_CONTROL_FILE: absolutePathSchema.optional(),
  DISPLAY: z
    .string()
    .regex(/^:[0-9]{1,4}$/, 'must name a local display, such as ":1"')
    .optional(),
});

/**
 * Linux limits a Unix socket's path to 107 bytes; a path near that is moved
 * to the temporary directory, which only happens for deep development paths.
 */
const maximumSocketPathLength = 100;

const piVariablesSchema = sharedVariablesSchema.extend({
  BARRACK_AGENT_HARNESS: z.literal("pi").default("pi"),
  BARRACK_WORKSPACE_DIRECTORY: absolutePathSchema,
  BARRACK_STATE_DIRECTORY: absolutePathSchema,
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
  /** The sandbox's graphical desktop; undefined for a sandbox without one. */
  desktop: DesktopConfiguration | undefined;
};

/**
 * A sandbox has a desktop when its image names a command that runs one
 * (`BARRACK_DESKTOP_COMMAND`, which Barrack's sandbox image sets): a program
 * that runs, as the agent and in the foreground until its standard input
 * closes, an X display and a VNC server for it on loopback.
 */
export type DesktopConfiguration = {
  command: string;
  /** The X display it runs, such as ":1"; the agent's programs are given it. */
  display: string;
  /** The loopback port its VNC server listens on. */
  vncPort: number;
  /**
   * Where the supervisor writes who holds the desktop's input, "agent" or
   * "user", for the agent's computer tool to read. The agent must be able to
   * read it and must not be able to write it.
   */
  controlFile: string;
};

/**
 * Which model Pi runs on, and the key for it, are not configured here: the
 * control plane sends them over the supervisor's connection
 * (`configure_model_access`), so no key is ever in the sandbox's environment.
 */
export type PiHarnessConfiguration = {
  kind: "pi";
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
  const { BARRACK_DESKTOP_COMMAND: desktopCommand, DISPLAY: display } = validation.data;
  if (desktopCommand !== undefined && display === undefined) {
    return {
      ok: false,
      problems: [
        "DISPLAY: is required with BARRACK_DESKTOP_COMMAND, to name the desktop's display",
      ],
    };
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
    desktop: toDesktopConfiguration(variables),
    agentHarness:
      variables.BARRACK_AGENT_HARNESS === "fake"
        ? { kind: "fake" }
        : {
            kind: "pi",
            workspaceDirectory: variables.BARRACK_WORKSPACE_DIRECTORY,
            stateDirectory: variables.BARRACK_STATE_DIRECTORY,
            agentUserName: variables.BARRACK_AGENT_USER,
            agentMayShareSupervisorUser:
              variables.BARRACK_AGENT_SHARES_SUPERVISOR_USER === "development-only",
          },
  };
}

/**
 * The agent is given a display only when the sandbox has a desktop, so on a
 * developer's machine the agent never opens windows on the developer's own.
 */
function toDesktopConfiguration(variables: Variables): DesktopConfiguration | undefined {
  const { BARRACK_DESKTOP_COMMAND: command, DISPLAY: display } = variables;
  if (command === undefined || display === undefined) {
    return undefined;
  }
  return {
    command,
    display,
    vncPort: variables.BARRACK_DESKTOP_VNC_PORT,
    controlFile:
      variables.BARRACK_DESKTOP_CONTROL_FILE ??
      path.join(variables.BARRACK_SUPERVISOR_STATE_DIRECTORY, "desktop-control"),
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
