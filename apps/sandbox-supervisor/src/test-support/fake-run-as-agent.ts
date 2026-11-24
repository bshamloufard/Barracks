import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes stand-ins for the image's `run-as-agent` helper into `directory`.
 * Changing user needs privileges a test does not have, so the stand-ins run
 * the command as the current user. Each records the arguments it was given
 * in `<helper>.arguments`, one per line.
 */
export async function writeFakeRunAsAgent(directory: string) {
  return {
    /** Runs the command after `--`, as `setpriv` would once it had changed user. */
    workingHelperPath: await writeHelper(
      directory,
      "working-run-as-agent",
      'while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"',
    ),
    /** Fails as `setpriv` does in a container that has dropped the capabilities it needs. */
    failingHelperPath: await writeHelper(
      directory,
      "failing-run-as-agent",
      'echo "setpriv: setresuid failed: Operation not permitted" >&2\nexit 127',
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
