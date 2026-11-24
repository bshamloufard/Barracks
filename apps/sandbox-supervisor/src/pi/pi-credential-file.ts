import path from "node:path";
import { type ModelCredential, modelProxyEndpointName } from "@barrack/protocol";
import type { AgentProcessLauncher } from "../agent-process/agent-process-launcher.js";
import type { PiCredentials } from "./pi-credential-plan.js";

/**
 * Hands Pi what reaches each provider it may use, through two of Pi's own
 * files in its agent directory:
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models-configuration.md
 *
 * - `auth.json` holds a credential per provider: the owner's key, or, for a
 *   provider whose traffic the control plane relays, the thread's token for
 *   the model proxy, which Pi sends where it would send a key. Pi reads it
 *   afresh whenever it changes (it compares the file's identity and times
 *   before each request), so a replaced credential is used from the next
 *   request with no restart.
 * - `models.json` gives each relayed provider the model proxy's address as
 *   its `baseUrl`, in place of the provider's own; everything else in the
 *   file is left as it is. Pi reads it when it starts.
 *
 * Both are written as the agent, because the agent owns that directory and
 * the supervisor may only pass through it (see the sandbox image's
 * README): a short Node program, run by the agent launcher, reads what to
 * write from its standard input, never its arguments or environment, writes
 * each file anew (`auth.json` only its user can read, 0600) and renames it
 * over the old, so Pi never reads half a file.
 *
 * Why files and not Pi's environment: every command the agent runs gets
 * Pi's environment, so a credential there is printed by anything that lists
 * it (`env`, a crash report), into the model's context and the thread's
 * history. In the file, only what reads it on purpose sees it. That the
 * agent can read a key placed here is inherent, since it must use it; a
 * proxy token it can read is worth nothing outside this thread's proxy.
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

  /** Makes `credentials` the only ones Pi has, each for its provider. */
  write(credentials: PiCredentials): Promise<void> {
    const entries = [...credentials].map(([providerId, credential]) => [
      providerId,
      describeEntry(credential),
    ]);
    const proxiedBaseUrls = [...credentials].flatMap(([providerId, credential]) =>
      credential.kind === "proxy_token" ? [[providerId, credential.baseUrl]] : [],
    );
    return this.#runAsAgent({
      credentials: entries.length === 0 ? null : Object.fromEntries(entries),
      proxiedBaseUrls: Object.fromEntries(proxiedBaseUrls),
    });
  }

  /** Leaves Pi with no credential at all, and no provider pointed at the model proxy. */
  erase(): Promise<void> {
    return this.#runAsAgent({ credentials: null, proxiedBaseUrls: {} });
  }

  #runAsAgent(instructions: FileInstructions): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.#launcher.launchCommand({
        executable: process.execPath,
        arguments: ["-e", replaceFilesScript, this.#agentDirectory],
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
      child.stdin.end(JSON.stringify({ ...instructions, proxyPathMarker }));
    });
  }
}

type FileInstructions = {
  /** `auth.json`'s contents, or null to remove it. */
  credentials: Record<string, object> | null;
  /** The model proxy's address for each relayed provider. */
  proxiedBaseUrls: Record<string, string>;
};

/**
 * What only the model proxy's addresses contain, so the program can tell a
 * `baseUrl` it wrote earlier (perhaps by a supervisor since replaced) from
 * one written by anything else, which it leaves alone.
 */
const proxyPathMarker = `/${modelProxyEndpointName}/`;

function describeEntry(credential: ModelCredential): object {
  if (credential.kind === "proxy_token") {
    return { type: "api_key", key: credential.secret };
  }
  return {
    type: "api_key",
    key: credential.secret,
    ...(Object.keys(credential.settings).length === 0 ? {} : { env: credential.settings }),
  };
}

/**
 * Writes `auth.json` from its standard input's `credentials` (removing it
 * for null), then sets `baseUrl` in `models.json` for each provider in
 * `proxiedBaseUrls`, and removes any earlier such address from providers
 * no longer listed. The agent can write `models.json` too, so it is read
 * as untrusted: anything that is not an object of providers is replaced.
 * New files are created exclusively beside the old and renamed over them.
 */
const replaceFilesScript = `
const fs = require("node:fs");
const path = require("node:path");
const [directory] = process.argv.slice(1);
const replace = (filePath, contents, mode) => {
  const temporaryPath = filePath + "." + require("node:crypto").randomUUID() + ".tmp";
  fs.writeFileSync(temporaryPath, contents, { mode, flag: "wx" });
  fs.renameSync(temporaryPath, filePath);
};
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const { credentials, proxiedBaseUrls, proxyPathMarker } = JSON.parse(Buffer.concat(chunks).toString());
  const authPath = path.join(directory, "auth.json");
  if (credentials === null) {
    fs.rmSync(authPath, { force: true });
  } else {
    replace(authPath, JSON.stringify(credentials), 0o600);
  }
  const modelsPath = path.join(directory, "models.json");
  let models = {};
  let existed = false;
  try {
    models = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    existed = true;
  } catch {}
  if (!isObject(models)) models = {};
  const providers = isObject(models.providers) ? models.providers : {};
  let changed = false;
  for (const [providerId, entry] of Object.entries(providers)) {
    const isOurs = isObject(entry) && typeof entry.baseUrl === "string" && entry.baseUrl.includes(proxyPathMarker);
    if (isOurs && !(providerId in proxiedBaseUrls)) {
      delete entry.baseUrl;
      if (Object.keys(entry).length === 0) delete providers[providerId];
      changed = true;
    }
  }
  for (const [providerId, baseUrl] of Object.entries(proxiedBaseUrls)) {
    const entry = isObject(providers[providerId]) ? providers[providerId] : {};
    if (entry.baseUrl !== baseUrl) changed = true;
    providers[providerId] = { ...entry, baseUrl };
  }
  if (changed || (!existed && Object.keys(providers).length > 0)) {
    replace(modelsPath, JSON.stringify({ ...models, providers }, null, 2), 0o600);
  }
});
`;
