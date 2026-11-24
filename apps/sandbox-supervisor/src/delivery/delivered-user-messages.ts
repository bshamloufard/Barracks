import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "../logger.js";

const recordFileName = "delivered-user-messages.json";

const recordSchema = z.strictObject({ deliveredThroughSequence: z.int().nonnegative() });

/**
 * How far this sandbox's agent has been handed the thread's user messages:
 * the sequence of the last one handed over. The control plane delivers
 * again whatever it has not seen acknowledged, so this is what keeps the
 * agent from being given one message twice, and it is kept on disk so that
 * still holds when the supervisor restarts (after a crash, or a sandbox
 * stop and start), since the agent's conversation survives that too.
 *
 * A message is noted here before the agent is handed it. A supervisor that
 * dies between the two loses that message rather than giving it twice; the
 * window is one file write.
 *
 * It lives in the supervisor's own state directory, which the agent cannot
 * write to. The agent can do nothing with it but deny itself messages.
 */
export class DeliveredUserMessages {
  readonly #filePath: string;
  readonly #logger: Logger;
  #deliveredThroughSequence: number;

  private constructor(filePath: string, deliveredThroughSequence: number, logger: Logger) {
    this.#filePath = filePath;
    this.#deliveredThroughSequence = deliveredThroughSequence;
    this.#logger = logger;
  }

  /**
   * Reads the record a previous run of the supervisor left, if any. One that
   * cannot be read counts as nothing delivered, which is logged: the control
   * plane's own record of acknowledged messages still keeps all but the last
   * message before the restart from being handed over again.
   */
  static async load(stateDirectory: string, logger: Logger): Promise<DeliveredUserMessages> {
    // The sandbox image makes the directory; elsewhere (`pnpm dev`) it may not exist yet.
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const filePath = path.join(stateDirectory, recordFileName);
    const deliveredThroughSequence = await readRecord(filePath, logger);
    logger.info(
      { deliveredThroughSequence },
      "Read how far user messages were handed to the agent",
    );
    return new DeliveredUserMessages(filePath, deliveredThroughSequence, logger);
  }

  get deliveredThroughSequence(): number {
    return this.#deliveredThroughSequence;
  }

  /** Whether the user message at `sequence` was already handed to the agent. */
  includes(sequence: number): boolean {
    return sequence <= this.#deliveredThroughSequence;
  }

  /**
   * Notes that the user message at `sequence` is being handed to the agent.
   * If the note cannot be written, the error is logged and the message is
   * still handed over: refusing it would strand the user, and the only risk
   * is that a restart before the next successful write repeats it.
   */
  async noteHandingOver(sequence: number): Promise<void> {
    this.#deliveredThroughSequence = Math.max(this.#deliveredThroughSequence, sequence);
    try {
      await writeRecord(this.#filePath, this.#deliveredThroughSequence);
    } catch (error) {
      this.#logger.error(
        { err: error, sequence },
        "Could not note on disk that a user message was handed to the agent; a restart could hand it over again",
      );
    }
  }
}

async function readRecord(filePath: string, logger: Logger): Promise<number> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return 0;
    }
    logger.error({ err: error, filePath }, "Could not read the record of delivered user messages");
    return 0;
  }
  const parsed = recordSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    logger.error({ filePath }, "The record of delivered user messages is damaged; ignoring it");
    return 0;
  }
  return parsed.data.deliveredThroughSequence;
}

/**
 * Written to a temporary file, flushed, and renamed over the record, so a
 * crash at any moment leaves either the old record or the new one.
 */
async function writeRecord(filePath: string, deliveredThroughSequence: number): Promise<void> {
  const temporaryPath = `${filePath}.writing`;
  const file = await open(temporaryPath, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify({ deliveredThroughSequence }));
    await file.datasync();
  } finally {
    await file.close();
  }
  await rename(temporaryPath, filePath);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
