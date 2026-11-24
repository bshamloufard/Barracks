/**
 * Barrack's Railway service, as Railway Infrastructure as Code: one service,
 * `control-plane`, built from the Dockerfile at the repository root. See
 * docs/deployment.md for the whole procedure.
 *
 * Things a newcomer may not expect:
 *
 * - Railway does not read this file when it deploys. The Railway CLI
 *   compares it with the linked project and applies the difference:
 *   `railway config plan`, then `railway config apply`. Railway's older
 *   `railway.json` (Config as Code) is deprecated, new services cannot use
 *   it, and existing files stop being read on 2026-12-01.
 *   https://docs.railway.com/infrastructure-as-code
 * - This file describes the whole service, so an apply may delete variables
 *   it leaves out (a plan marks every deletion). Every secret is therefore
 *   listed with `preserve()`, which keeps the value set in Railway's
 *   dashboard and puts none in the repository. Read every plan before
 *   applying it.
 * - The repository itself is connected in the dashboard, so this file names
 *   no GitHub repository and works from a fork unchanged.
 */
import { defineRailway, preserve, service } from "railway/iac";

/**
 * The domain Railway generates for the service. Railway, not JavaScript,
 * fills in this placeholder, in its own reference syntax.
 * https://docs.railway.com/variables#referencing-variables-in-the-same-service
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: Railway's reference syntax, resolved by Railway.
const publicDomain = "${{RAILWAY_PUBLIC_DOMAIN}}";

export default defineRailway((context, project) => {
  const controlPlane = service("control-plane", {
    // Railway would find the root Dockerfile by itself; saying so keeps it
    // from ever falling back to its default builder, Railpack.
    // https://docs.railway.com/builds/dockerfiles
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      // A new deployment receives traffic only once this answers 2xx, which
      // the control plane does only after its database is migrated. Railway
      // checks it while deploying, never afterwards.
      // https://docs.railway.com/deployments/healthchecks
      healthcheckPath: "/health",
      healthcheckTimeout: 300,
      // Exactly one replica. Each instance relays only the connections it
      // holds itself, so a second replica would routinely split a thread's
      // watchers from its supervisor. (Two instances do run at once for a
      // while on every redeploy; see below. Everything they share is safe
      // for that, but it is a moment, not a way to run.)
      numReplicas: 1,
      // Always on: never put to sleep when idle (Railway's "serverless").
      // https://docs.railway.com/deployments/serverless
      sleepApplication: false,
      // A redeploy runs two instances side by side. The new one starts,
      // migrates the database and begins its lifecycle sweeps while the old
      // one still serves every connection, until the health check passes;
      // only then does traffic move to it. The old one is then sent SIGTERM
      // after the overlap time (none here, so at once) and killed after the
      // draining time, which is 0 seconds unless set. Its shutdown closes
      // its connections at once (supervisors and browsers reconnect to the
      // new instance) and then waits for sandbox operations under way,
      // which on Daytona take up to a minute or two. No overlap shortens
      // the time both run, but cannot remove it, so everything the two
      // share is safe for it: see "Two instances at once" in
      // docs/deployment.md.
      // https://docs.railway.com/deployments/healthchecks
      // https://docs.railway.com/deployments/deployment-teardown
      drainingSeconds: 120,
      overlapSeconds: 0,
      // Restart after a crash. A clean exit only ever follows Railway's own
      // SIGTERM. Ten restarts is the most the Free plan and trials allow.
      // https://docs.railway.com/deployments/restart-policy
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    env: {
      // Railway health-checks, and routes its generated domain to, the port
      // in PORT; the image listens on 8787.
      // https://docs.railway.com/deployments/healthchecks#configure-the-healthcheck-port
      PORT: "8787",
      BARRACK_SANDBOX_PROVIDER: "daytona",
      BARRACK_AGENT_HARNESS: "pi",
      // Sandboxes and browsers reach the control plane at its generated
      // *.up.railway.app domain. Below Daytona's Tier 3, sandboxes may reach
      // only listed services, which include *.railway.app but not a custom
      // domain of your own. https://www.daytona.io/docs/en/network-limits
      BARRACK_SANDBOX_CONTROL_PLANE_URL: `wss://${publicDomain}`,
      BARRACK_ALLOWED_CLIENT_ORIGINS: `https://${publicDomain}`,
      // Users sign in with Supabase Auth, and the control plane verifies
      // their tokens itself. Set in the dashboard: the project's URL, its
      // publishable key (never a secret key) and the email addresses allowed
      // to use this installation.
      BARRACK_AUTHENTICATION: "supabase",
      BARRACK_SUPABASE_URL: preserve(),
      BARRACK_SUPABASE_PUBLISHABLE_KEY: preserve(),
      BARRACK_ALLOWED_USER_EMAILS: preserve(),
      // Set in the dashboard: the key users' model credentials are sealed
      // under (losing it loses them), the Daytona snapshot and key, and
      // Supabase's session pooler URL and certificate authority.
      BARRACK_MODEL_CREDENTIAL_KEY: preserve(),
      BARRACK_MODEL_CREDENTIAL_PREVIOUS_KEYS: preserve(),
      BARRACK_DAYTONA_SNAPSHOT: preserve(),
      DAYTONA_API_KEY: preserve(),
      BARRACK_DATABASE_URL: preserve(),
      BARRACK_DATABASE_CA_CERTIFICATE: preserve(),
      // Optional, all four or none: the GitHub App through which users
      // reach private repositories and publish (step 4 of the guide). Kept
      // like the other secrets, so an apply never deletes them once set.
      BARRACK_GITHUB_APP_CLIENT_ID: preserve(),
      BARRACK_GITHUB_APP_CLIENT_SECRET: preserve(),
      BARRACK_GITHUB_APP_PRIVATE_KEY: preserve(),
      BARRACK_GITHUB_APP_SLUG: preserve(),
    },
  });

  // The project keeps the name it was given in Railway.
  return project(context.projectName ?? "barrack", { resources: [controlPlane] });
});
