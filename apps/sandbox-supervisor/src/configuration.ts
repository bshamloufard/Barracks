import path from "node:path";
import { identifierSchema } from "@barrack/protocol";
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
  BARRACK_THREAD_ID: identifierSchema,
  BARRACK_SUPERVISOR_TOKEN: z.string().min(1),
  BARRACK_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const piVariablesSchema = sharedVariablesSchema.extend({
  BARRACK_AGENT_HARNESS: z.literal("pi").default("pi"),
  BARRACK_MODEL: z
    .string()
    .regex(/^[^/\s]+\/\S+$/, 'must be "provider/model", e.g. "openai/gpt-6"'),
  BARRACK_WORKSPACE_DIRECTORY: absoluteDirectorySchema,
  BARRACK_STATE_DIRECTORY: absoluteDirectorySchema,
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
  logLevel: LogLevel;
};

export type PiHarnessConfiguration = {
  kind: "pi";
  /** In Pi's `provider/model` form. */
  model: string;
  workspaceDirectory: string;
  stateDirectory: string;
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
    logLevel: variables.BARRACK_LOG_LEVEL,
    agentHarness:
      variables.BARRACK_AGENT_HARNESS === "fake"
        ? { kind: "fake" }
        : {
            kind: "pi",
            model: variables.BARRACK_MODEL,
            workspaceDirectory: variables.BARRACK_WORKSPACE_DIRECTORY,
            stateDirectory: variables.BARRACK_STATE_DIRECTORY,
          },
  };
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
