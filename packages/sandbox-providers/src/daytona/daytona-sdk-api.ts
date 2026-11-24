import { Daytona, DaytonaConnectionError, DaytonaError, DaytonaTimeoutError } from "@daytona/sdk";
import type { Sandbox } from "@daytona/sdk/v0";
import { type DaytonaApi, DaytonaApiFailure, type DaytonaSandboxRecord } from "./daytona-api.js";

/**
 * `DaytonaApi` on the official SDK. SDK 2.x serves both of Daytona's
 * platforms; Barrack uses the generally available one through the SDK's
 * `v0` namespace, because the newer platform is still in alpha.
 * https://www.daytona.io/docs/en/upgrade-to-v2/
 *
 * Each call looks the sandbox up first, because the SDK's operations are
 * methods of a sandbox object rather than functions of an ID.
 */
export function createDaytonaSdkApi(apiKey: string): DaytonaApi {
  const daytona = new Daytona({ apiKey });
  const getSandbox = (sandboxId: string): Promise<Sandbox> => daytona.v0.get(sandboxId);

  return {
    createSandbox: (parameters, timeoutInSeconds) =>
      translateFailures(async () =>
        toRecord(await daytona.v0.create(parameters, { timeout: timeoutInSeconds })),
      ),
    findSandbox: (idOrName) =>
      translateFailures(async () => {
        try {
          return toRecord(await getSandbox(idOrName));
        } catch (error) {
          if (error instanceof DaytonaError && error.statusCode === 404) {
            return undefined;
          }
          throw error;
        }
      }),
    startSandbox: (sandboxId, timeoutInSeconds) =>
      translateFailures(async () => (await getSandbox(sandboxId)).start(timeoutInSeconds)),
    stopSandbox: (sandboxId, timeoutInSeconds) =>
      translateFailures(async () => (await getSandbox(sandboxId)).stop(timeoutInSeconds)),
    waitUntilStarted: (sandboxId, timeoutInSeconds) =>
      translateFailures(async () =>
        (await getSandbox(sandboxId)).waitUntilStarted(timeoutInSeconds),
      ),
    waitUntilStopped: (sandboxId, timeoutInSeconds) =>
      translateFailures(async () =>
        (await getSandbox(sandboxId)).waitUntilStopped(timeoutInSeconds),
      ),
    deleteSandbox: (sandboxId, timeoutInSeconds) =>
      translateFailures(async () => (await getSandbox(sandboxId)).delete(timeoutInSeconds, true)),
    executeCommand: (sandboxId, command, environment, timeoutInSeconds) =>
      translateFailures(async () => {
        const sandbox = await getSandbox(sandboxId);
        const response = await sandbox.process.executeCommand(
          command,
          undefined,
          environment === undefined ? undefined : { ...environment },
          timeoutInSeconds,
        );
        return { exitCode: response.exitCode, output: response.result };
      }),
    uploadFile: (sandboxId, path, content, timeoutInSeconds) =>
      translateFailures(async () =>
        (await getSandbox(sandboxId)).fs.uploadFile(content, path, timeoutInSeconds),
      ),
    setFilePermissions: (sandboxId, path, permissions) =>
      translateFailures(async () =>
        (await getSandbox(sandboxId)).fs.setFilePermissions(path, permissions),
      ),
    createSignedPreviewUrl: (sandboxId, port, expiresInSeconds) =>
      translateFailures(async () => {
        const signed = await (await getSandbox(sandboxId)).getSignedPreviewUrl(
          port,
          expiresInSeconds,
        );
        return { url: signed.url };
      }),
  };
}

function toRecord(sandbox: Sandbox): DaytonaSandboxRecord {
  return {
    id: sandbox.id,
    state: sandbox.state,
    errorReason: sandbox.errorReason,
    labels: sandbox.labels,
    environment: sandbox.env,
  };
}

async function translateFailures<Result>(call: () => Promise<Result>): Promise<Result> {
  try {
    return await call();
  } catch (error) {
    throw toDaytonaApiFailure(error);
  }
}

function toDaytonaApiFailure(error: unknown): DaytonaApiFailure {
  if (!(error instanceof DaytonaError)) {
    const message = error instanceof Error ? error.message : String(error);
    return new DaytonaApiFailure(message, undefined, false);
  }
  const isTransportFailure =
    error instanceof DaytonaConnectionError || error instanceof DaytonaTimeoutError;
  return new DaytonaApiFailure(error.message, error.statusCode, isTransportFailure);
}
