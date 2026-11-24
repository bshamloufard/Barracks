import { decodeJwt } from "jose";
import { z } from "zod";
import { describeProblems } from "../database/database-configuration.js";
import type { SupabaseProject } from "./supabase-project.js";
import type { UserAdmission } from "./user-admission.js";

/**
 * How users prove who they are, read from environment variables:
 *
 * - `supabase` (the default): Supabase Auth signs users in, and the control
 *   plane verifies their access tokens against the project's published
 *   keys. The installation admits the email addresses it lists, or, if told
 *   in so many words, anyone who can sign in.
 * - `development-single-user`: no sign-in at all, one fixed user. Only for a
 *   control plane on a loopback address (checked with the other settings).
 */
export type AuthenticationConfiguration =
  | { method: "supabase"; project: SupabaseProject; admission: UserAdmission }
  | { method: "development-single-user" };

export type AuthenticationConfigurationResult =
  | { ok: true; configuration: AuthenticationConfiguration }
  | { ok: false; problems: string[] };

/** The value of `BARRACK_ALLOWED_USER_EMAILS` that admits everyone who can sign in. */
export const anyoneWhoCanSignIn = "anyone-who-can-sign-in";

const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);

const methodSchema = z.object({
  BARRACK_AUTHENTICATION: z.enum(["supabase", "development-single-user"]).default("supabase"),
});

/**
 * HTTPS, except on this machine, where a local Supabase stack (or the tests'
 * stand-in) serves plain HTTP. Without TLS, anyone on the path could hand
 * the control plane a key set of their own and sign in as anyone.
 */
const supabaseUrlSchema = z
  .url({ protocol: /^https?$/, error: "must be the project's https:// URL" })
  .refine((url) => {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" || loopbackHostnames.has(hostname);
  }, "must use https://, except on a loopback address")
  .transform((url) => url.replace(/\/+$/, ""));

const publishableKeySchema = z
  .string()
  .min(1)
  .refine((key) => !isSecretKey(key), {
    error:
      "is a secret key, which must never reach a browser; use the project's publishable key (sb_publishable_…)",
  });

const allowedEmailsSchema = z
  .string({
    error: `required with Supabase: the comma-separated email addresses allowed to use this installation, or "${anyoneWhoCanSignIn}"`,
  })
  .transform((text) =>
    text
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== ""),
  )
  .pipe(
    z
      .array(z.union([z.literal(anyoneWhoCanSignIn), z.email()]))
      .min(1, `must list at least one email address, or be "${anyoneWhoCanSignIn}"`)
      // Mixed with addresses, it would suggest the list still mattered.
      .refine((entries) => !entries.includes(anyoneWhoCanSignIn) || entries.length === 1, {
        error: `must be either "${anyoneWhoCanSignIn}" alone or a list of email addresses`,
      }),
  );

const supabaseSchema = z.object({
  BARRACK_SUPABASE_URL: supabaseUrlSchema,
  BARRACK_SUPABASE_PUBLISHABLE_KEY: publishableKeySchema,
  BARRACK_SUPABASE_JWT_ISSUER: z.url().optional(),
  BARRACK_ALLOWED_USER_EMAILS: allowedEmailsSchema,
});

export function readAuthenticationConfiguration(
  environment: NodeJS.ProcessEnv,
): AuthenticationConfigurationResult {
  const method = methodSchema.safeParse(environment);
  if (!method.success) {
    return { ok: false, problems: describeProblems(method.error) };
  }
  if (method.data.BARRACK_AUTHENTICATION === "development-single-user") {
    return { ok: true, configuration: { method: "development-single-user" } };
  }
  const settings = supabaseSchema.safeParse(environment);
  if (!settings.success) {
    return { ok: false, problems: describeProblems(settings.error) };
  }
  const { data } = settings;
  return {
    ok: true,
    configuration: {
      method: "supabase",
      project: {
        url: data.BARRACK_SUPABASE_URL,
        publishableKey: data.BARRACK_SUPABASE_PUBLISHABLE_KEY,
        issuer: data.BARRACK_SUPABASE_JWT_ISSUER ?? `${data.BARRACK_SUPABASE_URL}/auth/v1`,
      },
      admission: toAdmission(data.BARRACK_ALLOWED_USER_EMAILS),
    },
  };
}

function toAdmission(entries: string[]): UserAdmission {
  if (entries.includes(anyoneWhoCanSignIn)) {
    return { kind: "anyone-who-can-sign-in" };
  }
  return { kind: "listed-email-addresses", emailAddresses: new Set(entries) };
}

/**
 * Supabase's secret keys start `sb_secret_`; its legacy keys are JWTs, of
 * which the `service_role` one bypasses every access rule.
 * https://supabase.com/docs/guides/api/api-keys
 */
function isSecretKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) {
    return true;
  }
  try {
    const { role } = decodeJwt(key);
    return role === "service_role";
  } catch {
    return false;
  }
}
