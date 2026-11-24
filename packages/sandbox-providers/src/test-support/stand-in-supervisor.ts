/**
 * A command that stands in for the sandbox supervisor in tests of the
 * local-process provider, so they need neither the supervisor's build nor
 * an agent. Like the real supervisor it is configured only through its
 * environment and runs until it is signalled. It:
 *
 * - writes the environment it was given and its working directory to
 *   `stand-in-launch.json` in that directory, for a test to inspect;
 * - connects to `STAND_IN_CONNECT_URL`, when given, so that a recorder
 *   standing in for the control plane can count its launches;
 * - exits at once with `STAND_IN_EXIT_CODE`, when given, as a crashing
 *   supervisor would.
 */
const standInScript = `
const { writeFileSync } = require("node:fs");
writeFileSync(
  "stand-in-launch.json",
  JSON.stringify({ environment: process.env, workingDirectory: process.cwd() }),
);
if (process.env.STAND_IN_EXIT_CODE !== undefined) {
  process.exit(Number(process.env.STAND_IN_EXIT_CODE));
}
if (process.env.STAND_IN_CONNECT_URL !== undefined) {
  new WebSocket(process.env.STAND_IN_CONNECT_URL);
}
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 60_000);
`;

export const standInSupervisorCommand: [string, ...string[]] = [
  process.execPath,
  "--eval",
  standInScript,
];

export const standInLaunchFileName = "stand-in-launch.json";
