import { text } from "node:stream/consumers";
import { runGitCredentialHelper } from "./git-credential-helper.js";

/**
 * The credential helper's entry point, configured in the cloned
 * repository as `credential.helper`. Git runs it as the agent, with the
 * supervisor's socket as its first argument and the operation as its last.
 */
const [socketPath, operation] = process.argv.slice(2);

if (socketPath === undefined) {
  process.stderr.write("Usage: git-credential-helper-main <socket path> <get|store|erase>\n");
  process.exitCode = 1;
} else {
  await runGitCredentialHelper(
    socketPath,
    operation,
    () => text(process.stdin),
    (output) => process.stdout.write(output),
    (output) => process.stderr.write(output),
  );
}
