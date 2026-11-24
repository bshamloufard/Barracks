import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import type { CreatePublicationBundle } from "@barrack/protocol";
import type { Logger } from "../logger.js";
import type { CloneRecord, ThreadWorkspace } from "./thread-workspace.js";
import { describeGitFailure } from "./thread-workspace.js";

/** Bundling an agent's commits takes seconds; anything far longer is stuck. */
const bundleTimeoutInMilliseconds = 2 * 60_000;
const uploadTimeoutInMilliseconds = 5 * 60_000;

export type PublicationBundleSettings = {
  workspace: ThreadWorkspace;
  supervisorStateDirectory: string;
  /** The control plane's address for HTTP, from its WebSocket address. */
  controlPlaneHttpUrl: string;
  supervisorToken: string;
  logger: Logger;
};

/**
 * Makes the bundle the control plane publishes from: the work branch's
 * commits since the commit it was cloned at, made by Git as the agent, into
 * a file only the supervisor can read, no larger than the control plane
 * asked for, and uploads it with the supervisor's own token. Throws, with a
 * reason for the user, when that cannot be done.
 */
export async function sendPublicationBundle(
  request: CreatePublicationBundle,
  settings: PublicationBundleSettings,
): Promise<void> {
  const { workspace, logger } = settings;
  const clone = await workspace.readCloneRecord();
  const git = workspace.git;
  if (clone === undefined || git === undefined) {
    throw new Error(
      "The repository is not in the sandbox's workspace, so there is nothing to publish.",
    );
  }
  const tip = await readWorkBranchTip(workspace, clone);
  if (tip === clone.baseCommit) {
    throw new Error(
      `The agent has not committed anything on ${clone.workBranch} yet, so there is nothing to publish.`,
    );
  }
  const bundlePath = path.join(
    settings.supervisorStateDirectory,
    `publication-${request.publicationId}.bundle`,
  );
  try {
    await writeBundle(workspace, clone, bundlePath, request.maximumSizeInBytes);
    logger.info(
      { publicationId: request.publicationId, sizeInBytes: (await stat(bundlePath)).size },
      "Made the bundle of the work branch; uploading it",
    );
    await upload(bundlePath, request, settings);
  } finally {
    await rm(bundlePath, { force: true });
  }
}

async function readWorkBranchTip(workspace: ThreadWorkspace, clone: CloneRecord): Promise<string> {
  const outcome = await workspace.git?.run(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${clone.workBranch}^{commit}`],
    { timeoutInMilliseconds: 30_000 },
  );
  if (outcome?.exitCode !== 0) {
    throw new Error(
      `The branch ${clone.workBranch} is no longer in the workspace, so there is nothing to publish.`,
    );
  }
  return outcome.standardOutput.trim();
}

async function writeBundle(
  workspace: ThreadWorkspace,
  clone: CloneRecord,
  bundlePath: string,
  maximumSizeInBytes: number,
): Promise<void> {
  const limit = new SizeLimit(maximumSizeInBytes);
  const file = createWriteStream(bundlePath, { mode: 0o600 });
  limit.pipe(file);
  const outcome = await workspace.git?.run(
    ["bundle", "create", "-", `${clone.baseCommit}..refs/heads/${clone.workBranch}`],
    { timeoutInMilliseconds: bundleTimeoutInMilliseconds, standardOutput: limit },
  );
  await finished(file);
  if (limit.wasExceeded) {
    throw new Error(
      `The work branch's commits come to more than ${maximumSizeInBytes} bytes, more than Barrack publishes.`,
    );
  }
  if (outcome?.exitCode !== 0) {
    throw new Error(
      `Git could not bundle the work branch's commits: ${describeGitFailure(outcome?.standardError ?? "", outcome?.exitCode ?? null)}`,
    );
  }
}

async function upload(
  bundlePath: string,
  request: CreatePublicationBundle,
  settings: PublicationBundleSettings,
): Promise<void> {
  const response = await fetch(new URL(request.uploadPath, settings.controlPlaneHttpUrl), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${settings.supervisorToken}`,
      "Content-Type": "application/octet-stream",
    },
    body: Readable.toWeb(createReadStream(bundlePath)) as ReadableStream<Uint8Array>,
    duplex: "half",
    signal: AbortSignal.timeout(uploadTimeoutInMilliseconds),
  } as RequestInit);
  if (!response.ok) {
    throw new Error(`The control plane refused the bundle (HTTP ${response.status}).`);
  }
}

function finished(file: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if (file.closed) {
      resolve();
      return;
    }
    file.once("close", resolve);
    file.once("error", reject);
  });
}

/** Passes bytes on until there are more than the limit, then passes nothing more. */
class SizeLimit extends Transform {
  readonly #maximumSizeInBytes: number;
  #passedBytes = 0;
  wasExceeded = false;

  constructor(maximumSizeInBytes: number) {
    super();
    this.#maximumSizeInBytes = maximumSizeInBytes;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#passedBytes += chunk.length;
    if (this.#passedBytes > this.#maximumSizeInBytes) {
      this.wasExceeded = true;
      callback();
      return;
    }
    callback(null, chunk);
  }
}
