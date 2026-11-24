import type { IncomingMessage } from "node:http";
import {
  JsonBodyScanner,
  type JsonBodyScannerLimits,
  type ScannedJsonBody,
} from "./json-body-scanner.js";

/** Bytes a request holds while it is read and relayed, to give back when it ends. */
export type HeldBytes = {
  /** Holds `bytes` from now on instead, once what is relayed replaces what was read. */
  resize(bytes: number): void;
  release(): void;
};

export type BodyReading =
  | { kind: "read"; bytes: Buffer; scanned: ScannedJsonBody; held: HeldBytes }
  | { kind: "invalid"; reason: string }
  | {
      kind: "too_large" | "instance_busy" | "share_used" | "too_slow" | "agent_went_away" | "ended";
    };

export type BodyReadingOptions = {
  /** The largest body accepted. */
  maximumBytes: number;
  /** How long the whole body may take to arrive. */
  deadlineInMilliseconds: number;
  /** Whose share of the instance's bytes it is counted against. */
  threadId: string;
  ownerUserId: string;
  scannerLimits: JsonBodyScannerLimits;
};

/**
 * Bytes of request bodies held at once by this instance while they are
 * read and relayed, so that many large requests together cannot exhaust
 * its memory; and, within that, by one thread and by one owner, so that
 * neither can take it all and starve everyone else: a thread may hold a
 * quarter of the instance's bytes and an owner half, each never less than
 * one body of the largest size. Each request takes its share as its bytes
 * arrive and gives it back once relayed.
 *
 * A body is held once while it is relayed (the bytes read, or what
 * replaces them), and counted once. For an instant it is held twice: when
 * its chunks are joined, and when a member the proxy rewrites is spliced
 * in (see `request-body.ts`). Of everything else the proxy keeps per
 * request, none grows with the body.
 */
export class RequestBodyBudget {
  readonly #limit: number;
  #held = 0;
  readonly #heldByThread = new Map<string, number>();
  readonly #heldByOwner = new Map<string, number>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Bytes of request bodies held now. */
  get held(): number {
    return this.#held;
  }

  /**
   * Reads the whole body, checking its JSON as it arrives, and refusing
   * one larger than `maximumBytes`, one that would take the instance, its
   * thread or its owner over their share, one invalid as JSON, and one
   * that takes longer than the deadline; stopping at once when `signal` is
   * aborted (`ended`), already or later. Settles exactly once, whatever the
   * request has already done, and then listens to it no more. A reading
   * that ends in anything but `read` holds nothing.
   */
  read(
    request: IncomingMessage,
    options: BodyReadingOptions,
    signal: AbortSignal,
  ): Promise<BodyReading> {
    if (signal.aborted) {
      return Promise.resolve({ kind: "ended" });
    }
    if (request.destroyed && !request.complete) {
      return Promise.resolve({ kind: "agent_went_away" });
    }
    return new Promise((resolve) => {
      const held = this.#hold(options);
      const scanner = new JsonBodyScanner(options.scannerLimits);
      let chunks: Buffer[] = [];
      let readBytes = 0;
      const settle = (reading: BodyReading) => {
        request.removeListener("data", onData);
        request.removeListener("end", onEnd);
        request.removeListener("error", onError);
        request.removeListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
        clearTimeout(deadline);
        chunks = [];
        if (reading.kind !== "read") {
          held.release();
        }
        resolve(reading);
      };
      const onData = (chunk: Buffer) => {
        if (readBytes + chunk.length > options.maximumBytes) {
          settle({ kind: "too_large" });
          return;
        }
        const refusal = held.take(chunk.length);
        if (refusal !== undefined) {
          settle({ kind: refusal });
          return;
        }
        readBytes += chunk.length;
        chunks.push(chunk);
        const problem = scanner.write(chunk);
        if (problem !== undefined) {
          settle(problem);
        }
      };
      const onEnd = () => {
        const outcome = scanner.finish();
        if (outcome.kind === "invalid") {
          settle(outcome);
          return;
        }
        const bytes = Buffer.concat(chunks, readBytes);
        settle({ kind: "read", bytes, scanned: outcome.body, held });
      };
      const onError = () => settle({ kind: "agent_went_away" });
      const onClose = () => {
        if (!request.complete) {
          settle({ kind: "agent_went_away" });
        }
      };
      const onAbort = () => settle({ kind: "ended" });
      const deadline = setTimeout(
        () => settle({ kind: "too_slow" }),
        options.deadlineInMilliseconds,
      );
      request.on("data", onData);
      request.once("end", onEnd);
      request.once("error", onError);
      request.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** One request's bytes, taken from the instance's, its thread's and its owner's shares. */
  #hold(options: BodyReadingOptions): HeldBytes & {
    take(bytes: number): "instance_busy" | "share_used" | undefined;
  } {
    const threadShare = Math.max(options.maximumBytes, Math.floor(this.#limit / 4));
    const ownerShare = Math.max(options.maximumBytes, Math.floor(this.#limit / 2));
    const { threadId, ownerUserId } = options;
    let taken = 0;
    let isReleased = false;
    const change = (bytes: number) => {
      taken += bytes;
      this.#held += bytes;
      adjust(this.#heldByThread, threadId, bytes);
      adjust(this.#heldByOwner, ownerUserId, bytes);
    };
    return {
      take: (bytes) => {
        if (this.#held + bytes > this.#limit) {
          return "instance_busy";
        }
        const thread = (this.#heldByThread.get(threadId) ?? 0) + bytes;
        const owner = (this.#heldByOwner.get(ownerUserId) ?? 0) + bytes;
        if (thread > threadShare || owner > ownerShare) {
          return "share_used";
        }
        change(bytes);
        return undefined;
      },
      // What replaces a body differs from it only in the few top-level
      // members the proxy writes out again, each at most 64 KiB (see
      // `request-body-members.ts`), so it is held whatever the shares.
      resize: (bytes) => {
        if (!isReleased) {
          change(bytes - taken);
        }
      },
      release: () => {
        if (!isReleased) {
          isReleased = true;
          change(-taken);
        }
      },
    };
  }
}

function adjust(heldBy: Map<string, number>, key: string, bytes: number): void {
  const held = (heldBy.get(key) ?? 0) + bytes;
  if (held === 0) {
    heldBy.delete(key);
  } else {
    heldBy.set(key, held);
  }
}
