import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublicationBundleUploads, PublicationError } from "./publication-bundle-uploads.js";

/**
 * Uploads are streamed to disk as they arrive; these check that what a
 * sandbox sends stops being written the moment nobody waits for it.
 */

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "barrack-uploads-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A body that sends `firstChunk` and then nothing more, never ending, as a stalled sandbox would. */
function stalledBody(firstChunk: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(firstChunk);
    },
  });
}

function expectUpload(uploads: PublicationBundleUploads, destinationPath: string) {
  return uploads.expect(
    {
      threadId: "thread-a",
      publicationId: "publication-1",
      destinationPath,
      maximumSizeInBytes: 1024,
    },
    60_000,
  );
}

describe("a publication bundle upload", () => {
  it("is stopped once the sandbox reports the bundle failed, rather than left writing", async () => {
    const uploads = new PublicationBundleUploads();
    const destinationPath = path.join(directory, "work.bundle");
    const received = expectUpload(uploads, destinationPath);
    received.catch(() => {});

    const receiving = uploads.receive("thread-a", "publication-1", stalledBody(new Uint8Array(10)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    uploads.fail("thread-a", "publication-1", "The sandbox gave up");

    expect(await receiving).toMatchObject({ kind: "failed" });
    await expect(received).rejects.toThrow(PublicationError);
    await expect(received).rejects.toThrow("The sandbox gave up");
  });

  it("is taken once, only for the thread it was asked of, and only up to its size", async () => {
    const uploads = new PublicationBundleUploads();
    const destinationPath = path.join(directory, "work.bundle");
    const received = expectUpload(uploads, destinationPath);
    received.catch(() => {});

    const fromAnotherThread = await uploads.receive(
      "thread-b",
      "publication-1",
      new Blob(["bundle"]).stream(),
    );
    const tooLarge = await uploads.receive(
      "thread-a",
      "publication-1",
      new Blob([new Uint8Array(2048)]).stream(),
    );
    const again = await uploads.receive("thread-a", "publication-1", new Blob(["bundle"]).stream());

    expect(fromAnotherThread).toEqual({ kind: "not_expected" });
    expect(tooLarge).toEqual({ kind: "too_large" });
    expect(again).toEqual({ kind: "not_expected" });
    await expect(received).rejects.toThrow("more than 1024 bytes");
    expect((await readFile(destinationPath)).length).toBeLessThanOrEqual(1024);
  });
});
