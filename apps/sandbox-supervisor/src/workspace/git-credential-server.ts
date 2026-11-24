import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { Logger } from "../logger.js";
import type { CredentialQuestion } from "./git-credential-helper.js";

export type GrantedCredential = { username: string; password: string };

export type CredentialAnswer =
  | { isGranted: true; credential: GrantedCredential }
  | { isGranted: false; reason: string };

export type GitCredentialServerSettings = {
  socketPath: string;
  /** The only repository credentials are given for, as cloned. */
  repositoryUrl: string;
  /** Asks the control plane; it decides the repository from the thread, not from anything sent. */
  requestCredential: () => Promise<CredentialAnswer>;
  logger: Logger;
};

/** Git asks one at a time per operation; a few at once covers parallel commands. */
const maximumConnections = 4;
const maximumQuestionLength = 8 * 1024;
const questionTimeoutInMilliseconds = 10_000;

/**
 * Where the credential helper asks for repository credentials: a Unix
 * socket that only the sandbox's users can reach, answered by the
 * supervisor by asking the control plane.
 *
 * The agent can ask here too, so it is assumed to hold whatever is
 * returned: a short-lived token that can only read this one repository.
 * Questions about any other host or path are answered with nothing, so Git
 * never sends the token elsewhere (a redirect, a submodule, another remote).
 * Nothing given out is written anywhere or logged.
 */
export class GitCredentialServer {
  readonly #settings: GitCredentialServerSettings;
  readonly #repository: URL;
  #server: Server | undefined;

  constructor(settings: GitCredentialServerSettings) {
    this.#settings = settings;
    this.#repository = new URL(settings.repositoryUrl);
  }

  /**
   * Listens on the socket, replacing one a previous supervisor process left.
   * The socket is open to everyone the directory it is in lets through: in
   * the sandbox image, the supervisor and the agent only.
   */
  async start(): Promise<void> {
    if (this.#server !== undefined) {
      return;
    }
    await rm(this.#settings.socketPath, { force: true });
    const server = createServer((socket) => this.#answer(socket));
    server.maxConnections = maximumConnections;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#settings.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(this.#settings.socketPath, 0o666);
    this.#server = server;
    this.#settings.logger.info(
      { socketPath: this.#settings.socketPath },
      "Answering Git's credential requests for the thread's repository",
    );
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Whether Git is asking about the thread's repository, and nothing else. */
  isAboutRepository(question: CredentialQuestion): boolean {
    const repositoryPath = withoutGitSuffix(this.#repository.pathname.replace(/^\/+/, ""));
    return (
      `${question.protocol}:` === this.#repository.protocol &&
      question.host === this.#repository.host &&
      withoutGitSuffix(question.path.replace(/^\/+/, "")) === repositoryPath
    );
  }

  #answer(socket: Socket): void {
    let received = "";
    socket.setTimeout(questionTimeoutInMilliseconds, () => socket.destroy());
    socket.on("error", (error) =>
      this.#settings.logger.warn({ err: error }, "A credential request's connection failed"),
    );
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString();
      if (received.length > maximumQuestionLength) {
        socket.destroy();
        return;
      }
      const lineEnd = received.indexOf("\n");
      if (lineEnd !== -1) {
        socket.removeAllListeners("data");
        this.#reply(socket, received.slice(0, lineEnd)).catch((error: unknown) => {
          this.#settings.logger.error({ err: error }, "Could not answer a credential request");
          socket.destroy();
        });
      }
    });
  }

  async #reply(socket: Socket, questionLine: string): Promise<void> {
    const question = parseQuestion(questionLine);
    if (question === undefined || !this.isAboutRepository(question)) {
      this.#settings.logger.warn(
        { host: question?.host, path: question?.path },
        "Gave no credentials for a request about another repository",
      );
      socket.end(`${JSON.stringify({})}\n`);
      return;
    }
    const answer = await this.#settings.requestCredential();
    if (!answer.isGranted) {
      this.#settings.logger.warn(
        { reason: answer.reason },
        "The control plane refused credentials",
      );
      socket.end(`${JSON.stringify({ refusal: answer.reason })}\n`);
      return;
    }
    this.#settings.logger.info("Gave Git read-only credentials for the thread's repository");
    socket.end(`${JSON.stringify(answer.credential)}\n`);
  }
}

function parseQuestion(line: string): CredentialQuestion | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (
      typeof value === "object" &&
      value !== null &&
      "protocol" in value &&
      "host" in value &&
      "path" in value &&
      typeof value.protocol === "string" &&
      typeof value.host === "string" &&
      typeof value.path === "string"
    ) {
      return { protocol: value.protocol, host: value.host, path: value.path };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function withoutGitSuffix(repositoryPath: string): string {
  return repositoryPath.endsWith(".git") ? repositoryPath.slice(0, -".git".length) : repositoryPath;
}
