import { createWriteStream } from "node:fs";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * The bundles the control plane has asked supervisors for and is waiting
 * on. A supervisor uploads a bundle with its own token to the address it
 * was given (see `buildPublicationBundleUploadPath`); an upload is taken
 * only for a publication of that supervisor's thread that is waiting, only
 * once, and only up to the size asked for. Anything else is refused.
 */

export class PublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationError";
  }
}

/** The thread is being deleted: the publication stops, and nothing of it is recorded. */
export class PublicationAbandonedError extends PublicationError {
  constructor() {
    super("This thread is being deleted, so its branch was not published.");
    this.name = "PublicationAbandonedError";
  }
}

type ExpectedUpload = {
  threadId: string;
  destinationPath: string;
  maximumSizeInBytes: number;
  received: PromiseWithResolvers<void>;
  isReceiving: boolean;
  /** Stops an upload under way once the publication no longer waits for it. */
  abortReceiving: AbortController;
  timer: NodeJS.Timeout;
};

export type UploadOutcome =
  | { kind: "received" }
  | { kind: "not_expected" }
  | { kind: "too_large" }
  | { kind: "failed"; reason: string };

export class PublicationBundleUploads {
  readonly #expected = new Map<string, ExpectedUpload>();

  /**
   * Waits for the bundle of `publicationId` to arrive at `destinationPath`.
   * Rejects with the supervisor's reason if it reports a failure, or after
   * `timeoutInMilliseconds`.
   */
  expect(
    expectation: {
      threadId: string;
      publicationId: string;
      destinationPath: string;
      maximumSizeInBytes: number;
    },
    timeoutInMilliseconds: number,
  ): Promise<void> {
    const received = Promise.withResolvers<void>();
    const timer = setTimeout(
      () =>
        this.#settle(
          expectation.publicationId,
          new PublicationError(
            "The sandbox did not send the branch's commits in time. Check that it is running, then try again.",
          ),
        ),
      timeoutInMilliseconds,
    );
    this.#expected.set(expectation.publicationId, {
      ...expectation,
      received,
      isReceiving: false,
      abortReceiving: new AbortController(),
      timer,
    });
    return received.promise;
  }

  /** The supervisor could not make or send the bundle; `reason` is for the user. */
  fail(threadId: string, publicationId: string, reason: string): void {
    if (this.#expected.get(publicationId)?.threadId !== threadId) {
      return;
    }
    this.#settle(publicationId, new PublicationError(reason));
  }

  /** Stops waiting, such as when the request could not be sent. */
  abandon(publicationId: string, reason: string): void {
    this.#settle(publicationId, new PublicationError(reason));
  }

  /** Stops waiting for every upload of the thread, such as when its sandbox stops. */
  abandonThread(threadId: string, reason: string): void {
    for (const [publicationId, expected] of this.#expected) {
      if (expected.threadId === threadId) {
        this.#settle(publicationId, new PublicationError(reason));
      }
    }
  }

  /**
   * Stores an upload's body if it is one being waited for, from that
   * thread's supervisor. It is counted as it streams to disk, never held in
   * memory, and stopped as soon as it passes its size or the publication
   * stops waiting for it (the sandbox reported a failure, or ran out of
   * time), so a sandbox cannot keep writing to a file nobody will read.
   */
  async receive(
    threadId: string,
    publicationId: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<UploadOutcome> {
    const expected = this.#expected.get(publicationId);
    if (
      expected === undefined ||
      expected.threadId !== threadId ||
      expected.isReceiving ||
      body === null
    ) {
      return { kind: "not_expected" };
    }
    expected.isReceiving = true;
    const limit = new FailPastSizeLimit(expected.maximumSizeInBytes);
    try {
      await pipeline(
        Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>),
        limit,
        createWriteStream(expected.destinationPath, { mode: 0o600 }),
        { signal: expected.abortReceiving.signal },
      );
      this.#settle(publicationId, undefined);
      return { kind: "received" };
    } catch (error) {
      const tooLarge = limit.wasExceeded;
      this.#settle(
        publicationId,
        new PublicationError(
          tooLarge
            ? `The branch's commits came to more than ${expected.maximumSizeInBytes} bytes, more than Barrack publishes.`
            : "The sandbox's upload of the branch's commits broke off. Try again.",
        ),
      );
      return tooLarge
        ? { kind: "too_large" }
        : { kind: "failed", reason: error instanceof Error ? error.message : "upload failed" };
    }
  }

  #settle(publicationId: string, failure: PublicationError | undefined): void {
    const expected = this.#expected.get(publicationId);
    if (expected === undefined) {
      return;
    }
    this.#expected.delete(publicationId);
    clearTimeout(expected.timer);
    if (failure === undefined) {
      expected.received.resolve();
    } else {
      expected.abortReceiving.abort();
      expected.received.reject(failure);
    }
  }
}

/**
 * Passes bytes through until there are more than the limit, then fails the
 * stream, which ends the upload: nothing more is read from the sandbox. The
 * supervisor's `DiscardPastSizeLimit` keeps reading and discards instead,
 * because what it reads is its own Git, which would wait for ever with its
 * output unread; an untrusted sandbox's upload is not worth reading further.
 */
class FailPastSizeLimit extends Transform {
  readonly #maximumSizeInBytes: number;
  #receivedBytes = 0;
  wasExceeded = false;

  constructor(maximumSizeInBytes: number) {
    super();
    this.#maximumSizeInBytes = maximumSizeInBytes;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#receivedBytes += chunk.length;
    if (this.#receivedBytes > this.#maximumSizeInBytes) {
      this.wasExceeded = true;
      callback(new Error("The upload exceeded its size limit"));
      return;
    }
    callback(null, chunk);
  }
}
