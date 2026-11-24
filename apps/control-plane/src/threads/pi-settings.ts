/**
 * Pi's own settings that a deployment may want every sandbox's Pi to have,
 * forwarded from the control plane's environment to sandboxes running Pi.
 * The supervisor passes every `PI_` variable on to Pi
 * (apps/sandbox-supervisor/src/pi/pi-environment.ts), and Pi documents them
 * here: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/environment-variables.md
 *
 * Only these are forwarded, not every `PI_` variable: a developer who runs
 * the control plane from inside a Pi session has that session's variables
 * set, which mean nothing in a sandbox. The rest that matter there the
 * supervisor sets itself (no version checks, no telemetry, the agent's own
 * directory).
 */
export const forwardedPiSettingNames = [
  // No automatic network activity, such as model catalogue refreshes, for
  // sandboxes without general internet access.
  "PI_OFFLINE",
  // `long` asks for extended prompt caching where the provider supports it.
  "PI_CACHE_RETENTION",
];

/** The forwarded settings that are set. They hold no secrets. */
export function readPiSettings(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const settings: Record<string, string> = {};
  for (const name of forwardedPiSettingNames) {
    const value = environment[name];
    if (value !== undefined && value !== "") {
      settings[name] = value;
    }
  }
  return settings;
}
