import type { CreateSandboxFromSnapshotParams } from "@daytona/sdk/v0";

/**
 * The few Daytona calls the provider makes, as a seam between the provider's
 * logic and the SDK. The provider is unit-tested against a fake of this
 * interface, and `daytona-sdk-api.ts` implements it with the real SDK.
 */
export interface DaytonaApi {
  createSandbox(
    parameters: DaytonaCreationParameters,
    timeoutInSeconds: number,
  ): Promise<DaytonaSandboxRecord>;
  /** The sandbox with this ID or name, or `undefined` if Daytona has none. */
  findSandbox(idOrName: string): Promise<DaytonaSandboxRecord | undefined>;
  startSandbox(sandboxId: string, timeoutInSeconds: number): Promise<void>;
  stopSandbox(sandboxId: string, timeoutInSeconds: number): Promise<void>;
  waitUntilStarted(sandboxId: string, timeoutInSeconds: number): Promise<void>;
  waitUntilStopped(sandboxId: string, timeoutInSeconds: number): Promise<void>;
  /** Deletes the sandbox and waits until it is gone. */
  deleteSandbox(sandboxId: string, timeoutInSeconds: number): Promise<void>;
  executeCommand(
    sandboxId: string,
    command: string,
    environment: Readonly<Record<string, string>> | undefined,
    timeoutInSeconds: number,
  ): Promise<DaytonaCommandResult>;
  createSignedPreviewUrl(
    sandboxId: string,
    port: number,
    expiresInSeconds: number,
  ): Promise<{ url: string }>;
}

/** The creation parameters Barrack sets, in the SDK's own terms. */
export type DaytonaCreationParameters = Required<
  Pick<
    CreateSandboxFromSnapshotParams,
    | "name"
    | "snapshot"
    | "envVars"
    | "labels"
    | "public"
    | "autoStopInterval"
    | "autoArchiveInterval"
    | "autoDeleteInterval"
  >
> &
  Pick<CreateSandboxFromSnapshotParams, "target">;

export type DaytonaSandboxRecord = {
  id: string;
  /** Daytona's state name, such as `started` or `archived`. */
  state: string | undefined;
  errorReason: string | undefined;
  labels: Readonly<Record<string, string>>;
  /** The environment the sandbox was created with, when Daytona returns it. */
  environment: Readonly<Record<string, string>> | undefined;
};

export type DaytonaCommandResult = { exitCode: number; output: string };

/**
 * A Daytona call that failed. It keeps only the HTTP status and the message,
 * never the SDK's error object, whose request (with the API key and the
 * supervisor's environment) a logger could otherwise write out.
 */
export class DaytonaApiFailure extends Error {
  /** The HTTP status Daytona answered with, if it answered at all. */
  readonly statusCode: number | undefined;
  /** The request never got an answer: a connection failure or a timeout. */
  readonly isTransportFailure: boolean;

  constructor(message: string, statusCode: number | undefined, isTransportFailure: boolean) {
    super(message);
    this.name = "DaytonaApiFailure";
    this.statusCode = statusCode;
    this.isTransportFailure = isTransportFailure;
  }
}
