import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSilentLogger } from "../test-support/silent-logger.js";
import { DeliveredUserMessages } from "./delivered-user-messages.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await mkdtemp(path.join(tmpdir(), "barrack-delivered-"));
});

afterEach(async () => {
  await rm(stateDirectory, { recursive: true, force: true });
});

function load(): Promise<DeliveredUserMessages> {
  return DeliveredUserMessages.load(stateDirectory, createSilentLogger());
}

describe("the record of user messages handed to the agent", () => {
  it("starts with nothing delivered in a fresh sandbox", async () => {
    const record = await load();

    expect(record.deliveredThroughSequence).toBe(0);
    expect(record.includes(1)).toBe(false);
  });

  it("is read back by the next supervisor process", async () => {
    const record = await load();
    await record.noteHandingOver(4);
    await record.noteHandingOver(9);

    const afterRestart = await load();

    expect(afterRestart.deliveredThroughSequence).toBe(9);
    expect(afterRestart.includes(4)).toBe(true);
    expect(afterRestart.includes(10)).toBe(false);
  });

  it("never moves back", async () => {
    const record = await load();
    await record.noteHandingOver(9);

    await record.noteHandingOver(4);

    expect((await load()).deliveredThroughSequence).toBe(9);
  });

  it("counts a damaged record as nothing delivered rather than failing to start", async () => {
    await writeFile(path.join(stateDirectory, "delivered-user-messages.json"), "{ half wri");

    expect((await load()).deliveredThroughSequence).toBe(0);
  });

  it("creates its directory when the sandbox did not", async () => {
    const missingDirectory = path.join(stateDirectory, "supervisor");
    const record = await DeliveredUserMessages.load(missingDirectory, createSilentLogger());

    await record.noteHandingOver(2);

    const recordFile = path.join(missingDirectory, "delivered-user-messages.json");
    expect(JSON.parse(await readFile(recordFile, "utf8"))).toEqual({ deliveredThroughSequence: 2 });
  });
});
