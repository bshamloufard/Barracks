import { z } from "zod";

/**
 * What a client needs to know before it can sign in, served without
 * authentication at `GET /api/client-configuration`. Clients learn where to
 * sign in from the control plane they are talking to, rather than having it
 * built in, so one build of a client serves any installation.
 *
 * - `supabase`: sign in with Supabase Auth, at `supabaseUrl` with the
 *   project's publishable key, which is meant to be public. Never a secret
 *   key: the control plane refuses to start with one.
 * - `development-single-user`: a control plane run for local development,
 *   on this machine only, with one fixed user. Every client is that user and
 *   authenticates with `accessToken`, which is not a secret.
 */
export const clientConfigurationPath = "/api/client-configuration";

export const clientConfigurationSchema = z.strictObject({
  authentication: z.discriminatedUnion("method", [
    z.strictObject({
      method: z.literal("supabase"),
      supabaseUrl: z.url({ protocol: /^https?$/ }),
      supabasePublishableKey: z.string().min(1),
    }),
    z.strictObject({
      method: z.literal("development-single-user"),
      accessToken: z.string().min(1),
    }),
  ]),
});

export type ClientConfiguration = z.infer<typeof clientConfigurationSchema>;
export type ClientAuthenticationConfiguration = ClientConfiguration["authentication"];
