import { z } from "zod";
import type { AuthenticationConfiguration } from "../authentication/authentication-configuration.js";

/**
 * Whether this installation lets its user run threads on their ChatGPT
 * plan, through OpenAI's "Sign in with ChatGPT" programme
 * (https://developers.openai.com/siwc), and where that programme is.
 *
 * Off unless the operator turns it on (`BARRACK_CHATGPT_PLAN_SIGN_IN=on`).
 * The programme's terms say that stored tokens "must be local and under
 * the user's control, not in a remote or managed environment", that
 * requests must come from "a remote runtime only that user controls", and
 * that one user's subscription must not serve another's requests; and its
 * documentation asks a paid or remotely hosted application to apply first
 * (https://openai.com/policies/sign-in-with-chatgpt-terms). The control
 * plane keeps the plan's tokens, so the feature is only for an
 * installation its ChatGPT account holder runs for themselves: turning it
 * on is refused unless the installation admits exactly one user.
 */
export type ChatGptPlanSettings =
  | { isOffered: false }
  | {
      isOffered: true;
      /** OpenAI's sign-in, `https://auth.openai.com`, or a stand-in for it in tests. */
      issuer: string;
    };

/** Where OpenAI's "Sign in with ChatGPT" programme signs users in. */
export const openAiSignInIssuer = "https://auth.openai.com";

const developmentOnlyPrefix = "development-only:";

const chatGptPlanEnvironmentSchema = z.object({
  BARRACK_CHATGPT_PLAN_SIGN_IN: z
    .enum(["off", "on"], { error: 'must be "off" (the default) or "on"' })
    .default("off"),
  BARRACK_CHATGPT_SIGN_IN_ISSUER: z
    .string()
    .regex(/^development-only:https?:\/\/[^/?#]+$/, {
      error:
        'only for tests and local development: "development-only:" followed by the origin of a stand-in for OpenAI\'s sign-in, such as development-only:http://127.0.0.1:4011',
    })
    .transform((value) => value.slice(developmentOnlyPrefix.length))
    .optional(),
  BARRACK_ALLOW_UNSAFE_MODEL_PROXY_UPSTREAM: z.string().optional(),
});

/** Every variable read here, for the deployment guide's check. */
export const chatGptPlanVariableNames = [
  "BARRACK_CHATGPT_PLAN_SIGN_IN",
  "BARRACK_CHATGPT_SIGN_IN_ISSUER",
];

export type ChatGptPlanSettingsResult =
  | { ok: true; settings: ChatGptPlanSettings }
  | { ok: false; problems: string[] };

export function readChatGptPlanSettings(
  environment: NodeJS.ProcessEnv,
  authentication: AuthenticationConfiguration,
): ChatGptPlanSettingsResult {
  const validation = chatGptPlanEnvironmentSchema.safeParse(environment);
  if (!validation.success) {
    return {
      ok: false,
      problems: validation.error.issues.map(
        (issue) => `${String(issue.path[0] ?? "environment")}: ${issue.message}`,
      ),
    };
  }
  const variables = validation.data;
  if (variables.BARRACK_CHATGPT_PLAN_SIGN_IN === "off") {
    return { ok: true, settings: { isOffered: false } };
  }
  const problems = [
    describeSeveralUsers(authentication),
    describeUnsafeIssuer(variables, authentication),
  ].filter((problem) => problem !== undefined);
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    settings: {
      isOffered: true,
      issuer: variables.BARRACK_CHATGPT_SIGN_IN_ISSUER ?? openAiSignInIssuer,
    },
  };
}

/**
 * Development mode has one user; with Supabase, the installation must list
 * exactly one email address, the account holder's own.
 */
function describeSeveralUsers(authentication: AuthenticationConfiguration): string | undefined {
  if (authentication.method === "development-single-user") {
    return undefined;
  }
  const { admission } = authentication;
  if (admission.kind === "listed-email-addresses" && admission.emailAddresses.size === 1) {
    return undefined;
  }
  return "BARRACK_CHATGPT_PLAN_SIGN_IN: on only where the installation admits exactly one user (BARRACK_ALLOWED_USER_EMAILS listing one address), since OpenAI's terms for ChatGPT plan sign-in allow its tokens to be kept only under the account holder's own control; see docs/deployment.md";
}

/**
 * A stand-in for OpenAI's sign-in would be handed the user's sign-in, so
 * outside development mode it needs the same second switch as the model
 * proxy's stand-in upstream.
 */
function describeUnsafeIssuer(
  variables: z.infer<typeof chatGptPlanEnvironmentSchema>,
  authentication: AuthenticationConfiguration,
): string | undefined {
  if (
    variables.BARRACK_CHATGPT_SIGN_IN_ISSUER === undefined ||
    authentication.method === "development-single-user" ||
    variables.BARRACK_ALLOW_UNSAFE_MODEL_PROXY_UPSTREAM === "development-only"
  ) {
    return undefined;
  }
  return "BARRACK_CHATGPT_SIGN_IN_ISSUER: hands the user's ChatGPT sign-in to that origin, so it is refused unless BARRACK_AUTHENTICATION=development-single-user or BARRACK_ALLOW_UNSAFE_MODEL_PROXY_UPSTREAM=development-only is also set; never set either in a deployment";
}
