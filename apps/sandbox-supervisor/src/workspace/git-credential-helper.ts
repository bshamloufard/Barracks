import { createConnection } from "node:net";

/**
 * Git's side of repository credentials: a credential helper, run by Git as
 * the agent, that asks the supervisor over a local socket. It holds nothing
 * itself, and never stores what it is given.
 *
 * Git runs a helper with one argument, `get`, `store` or `erase`, and
 * writes the request's attributes to its standard input, one `key=value`
 * per line, ending with a blank line. For `get`, the helper prints the
 * attributes it can fill in, here `username` and `password`, the same way;
 * printing nothing lets Git go on without. `store` and `erase` need no
 * answer. https://git-scm.com/docs/gitcredentials#_custom_helpers
 *
 * The protocol on the socket is one JSON line each way: the request's
 * `protocol`, `host` and `path`, then `{ username, password }` or
 * `{ refusal }`.
 */

/** The supervisor may need to ask GitHub for a token, which can take a while. */
const answerTimeoutInMilliseconds = 60_000;
const maximumAnswerLength = 64 * 1024;

export type CredentialQuestion = { protocol: string; host: string; path: string };

/** Reads Git's `key=value` lines up to the blank line that ends them. */
export function parseCredentialAttributes(input: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const line of input.split("\n")) {
    if (line === "") {
      break;
    }
    const separator = line.indexOf("=");
    if (separator > 0) {
      attributes.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return attributes;
}

/** What the helper prints for Git; empty when there is no credential. */
export function formatCredentialAnswer(answer: unknown): string {
  if (
    typeof answer === "object" &&
    answer !== null &&
    "username" in answer &&
    "password" in answer &&
    typeof answer.username === "string" &&
    typeof answer.password === "string" &&
    !/[\n\0]/.test(answer.username + answer.password)
  ) {
    return `username=${answer.username}\npassword=${answer.password}\n`;
  }
  return "";
}

export async function runGitCredentialHelper(
  socketPath: string,
  operation: string | undefined,
  readInput: () => Promise<string>,
  writeOutput: (text: string) => void,
  writeError: (text: string) => void,
): Promise<void> {
  const attributes = parseCredentialAttributes(await readInput());
  if (operation !== "get") {
    return;
  }
  const question: CredentialQuestion = {
    protocol: attributes.get("protocol") ?? "",
    host: attributes.get("host") ?? "",
    path: attributes.get("path") ?? "",
  };
  try {
    const answer = await ask(socketPath, question);
    if (typeof answer === "object" && answer !== null && "refusal" in answer) {
      writeError(`Barrack could not provide repository credentials: ${String(answer.refusal)}\n`);
      return;
    }
    writeOutput(formatCredentialAnswer(answer));
  } catch (error) {
    writeError(
      `Barrack could not provide repository credentials: ${error instanceof Error ? error.message : "the supervisor did not answer"}\n`,
    );
  }
}

function ask(socketPath: string, question: CredentialQuestion): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let answer = "";
    socket.setTimeout(answerTimeoutInMilliseconds, () => {
      socket.destroy(new Error("the supervisor did not answer in time"));
    });
    socket.on("connect", () => socket.write(`${JSON.stringify(question)}\n`));
    socket.on("data", (chunk: Buffer) => {
      answer += chunk.toString();
      if (answer.length > maximumAnswerLength) {
        socket.destroy(new Error("the supervisor's answer was too long"));
        return;
      }
      const lineEnd = answer.indexOf("\n");
      if (lineEnd !== -1) {
        socket.end();
        try {
          resolve(JSON.parse(answer.slice(0, lineEnd)));
        } catch {
          reject(new Error("the supervisor's answer was not understood"));
        }
      }
    });
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("the supervisor closed the connection")));
  });
}
