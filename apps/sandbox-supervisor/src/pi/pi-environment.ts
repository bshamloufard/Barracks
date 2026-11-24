/**
 * Pi's tools run with whatever environment Pi has, and the model can read
 * all of it, so Pi gets an environment built from an allowlist rather than a
 * copy of the supervisor's. The supervisor's control-plane token is left out.
 *
 * That keeps the token out of anything Pi prints or sends to the model by
 * accident. Whether it also keeps it from a determined agent depends on the
 * user Pi runs as (see src/agent-process). In the sandbox image Pi runs as a
 * user of its own, and Linux shows a process's environment only to the
 * process's own user. Run as the supervisor's user, as on a developer's
 * machine, a tool can read the token from `/proc/<supervisor pid>/environ`;
 * deleting it from `process.env` would not help, because Linux reports the
 * environment the process started with.
 *
 * The variables that name the user (`HOME`, `USER`, `LOGNAME`, `SHELL`) are
 * copied here and then set by the launcher to the user Pi actually runs as.
 */

/** What ordinary command-line tools expect to find. */
const basicVariableNames = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  // Sandboxes behind an egress proxy need these to reach the model provider.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

/** Pi's own settings, such as `PI_OFFLINE`. */
const piSettingPrefix = "PI_";

export function buildPiEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  agentDirectory: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(sourceEnvironment)) {
    if (value !== undefined && isPassedToPi(name)) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    // Pi keeps credentials, settings and custom models here, under the
    // supervisor's state directory rather than the user's home.
    PI_CODING_AGENT_DIR: agentDirectory,
    // No update checks or install telemetry from inside a sandbox.
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
}

/**
 * Model provider keys are deliberately not passed, nor are ambient cloud
 * credentials (`AWS_*`, `GOOGLE_*`): Pi would pick any of them up silently,
 * and every command the agent runs would inherit them. The thread owner's
 * key reaches Pi through its credential file instead (`pi-credential-file.ts`).
 */
function isPassedToPi(variableName: string): boolean {
  return basicVariableNames.includes(variableName) || variableName.startsWith(piSettingPrefix);
}
