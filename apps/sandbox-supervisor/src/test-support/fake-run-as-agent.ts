import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes stand-ins for the image's `run-as-agent` helper into `directory`.
 * Changing user needs privileges a test does not have, so the stand-ins run
 * the command as the current user. Each records the arguments it was given
 * in `<helper>.arguments`, one per line.
 *
 * The working stand-in does what the real helper does that a test can: it
 * sets no_new_privs (with util-linux's `setpriv`, so Linux only) and runs
 * its arguments as the command. A Node command it runs is made to report
 * the IDs of `pretendToBe` as its own, so the supervisor's startup check of
 * who the helper makes its caller sees the agent it expects.
 */
export async function writeFakeRunAsAgent(
  directory: string,
  pretendToBe: { userId: number; groupId: number } = { userId: 10_002, groupId: 10_002 },
) {
  const pretendScriptPath = path.join(directory, "pretend-to-be-the-agent.cjs");
  await writeFile(
    pretendScriptPath,
    [
      `process.getuid = () => ${pretendToBe.userId};`,
      `process.getgid = () => ${pretendToBe.groupId};`,
      `process.getgroups = () => [${pretendToBe.groupId}];`,
    ].join("\n"),
  );
  return {
    /** Runs its arguments as the command, as the real helper does once it has changed user. */
    workingHelperPath: await writeHelper(
      directory,
      "working-run-as-agent",
      `export NODE_OPTIONS="--require=${pretendScriptPath}"\nexec setpriv --no-new-privs "$@"`,
    ),
    /** Fails as the helper does in a container that has dropped the capabilities it needs. */
    failingHelperPath: await writeHelper(
      directory,
      "failing-run-as-agent",
      'echo "run-as-agent: setgroups failed: Operation not permitted" >&2\nexit 126',
    ),
  };
}

async function writeHelper(directory: string, name: string, body: string): Promise<string> {
  const helperPath = path.join(directory, name);
  const recordArguments = `printf '%s\\n' "$@" > "${helperPath}.arguments"`;
  await writeFile(helperPath, `#!/bin/sh\n${recordArguments}\n${body}\n`);
  await chmod(helperPath, 0o755);
  return helperPath;
}
