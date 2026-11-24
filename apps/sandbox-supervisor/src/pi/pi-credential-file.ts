import path from "node:path";
import type { ModelCredential } from "@barrack/protocol";
import type { AgentProcessLauncher } from "../agent-process/agent-process-launcher.js";

/**
 * Hands Pi the thread owner's key through Pi's own credential file,
 * `auth.json` in its agent directory, which Pi reads afresh whenever it
 * changes (it compares the file's identity and times before each request),
 * so a replaced key is used from the next request with no restart.
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md
 *
 * The file is written as the agent, because the agent owns that directory
 * and the supervisor may only pass through it (see the sandbox image's
 * README): a short Node program, run by the agent launcher, reads the
 * contents from its standard input, never its arguments or environment,
 * writes them to a new file only its user can read (0600), and renames it
 * over `auth.json`, so Pi never reads half a file. An empty input removes
 * the file.
 *
 * Why a file and not Pi's environment: every command the agent runs gets
 * Pi's environment, so a key there is printed by anything that lists it
 * (`env`, a crash report), into the model's context and the thread's
 * history. In the file, only what reads it on purpose sees it; that the
 * agent can is inherent, since it must use the key (see the supervisor's
 * README). And Pi rereads the file, which a later refreshed token needs.
 */
export class PiCredentialFile {
  readonly #launcher: AgentProcessLauncher;
  readonly #filePath: string;
  readonly #agentDirectory: string;

  constructor(launcher: AgentProcessLauncher, agentDirectory: string) {
    this.#launcher = launcher;
    this.#agentDirectory = agentDirectory;
    this.#filePath = path.join(agentDirectory, "auth.json");
  }

  get filePath(): string {
    return this.#filePath;
  }

  /** Makes `credential` the only one Pi has, for `providerId`. */
  write(providerId: string, credential: ModelCredential): Promise<void> {
    const entry = {
      type: "api_key",
      key: credential.secret,
      ...(Object.keys(credential.settings).length === 0 ? {} : { env: credential.settings }),
    };
    return this.#runAsAgent(JSON.stringify({ [providerId]: entry }));
  }

  /** Leaves Pi with no credential at all. */
  erase(): Promise<void> {
    return this.#runAsAgent("");
  }

  #runAsAgent(contents: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.#launcher.launchCommand({
        executable: process.execPath,
        arguments: ["-e", replaceFileScript, this.#filePath],
        workingDirectory: this.#agentDirectory,
        // Nothing of the supervisor's: the program needs no variable at all.
        environment: {},
      });
      let standardError = "";
      child.stdout.resume();
      child.stderr.on("data", (chunk: Buffer) => {
        standardError = `${standardError}${chunk.toString()}`.slice(-2_000);
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        if (exitCode === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `Writing the agent's credential file failed with exit code ${exitCode}: ${standardError.trim()}`,
          ),
        );
      });
      child.stdin.end(contents);
    });
  }
}

/**
 * Replaces the file named in its argument with its standard input, or
 * removes it when the input is empty. The new file is created exclusively,
 * with mode 0600, beside the old, and renamed over it.
 */
const replaceFileScript = `
const fs = require("node:fs");
const [filePath] = process.argv.slice(1);
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const contents = Buffer.concat(chunks);
  if (contents.length === 0) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  const temporaryPath = filePath + "." + require("node:crypto").randomUUID() + ".tmp";
  fs.writeFileSync(temporaryPath, contents, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporaryPath, filePath);
});
`;
