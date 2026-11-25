import { describe, expect, it } from "vitest";
import { redactedSecretMarker, SecretRedaction } from "./secret-redaction.js";

/** A ChatGPT plan's access token is a JWT of a couple of kilobytes. */
const longSecret = `eyJ${"a".repeat(1200)}.${"b".repeat(900)}.sig`;

/** What the stream gives out for each chunk written, as text, before the next is written. */
function passThrough(secret: string, chunks: string[]): { perChunk: string[]; atEnd: string } {
  const redaction = new SecretRedaction(secret);
  const perChunk: string[] = [];
  let current = "";
  redaction.on("data", (data: Buffer) => {
    current += data.toString();
  });
  for (const chunk of chunks) {
    redaction.write(Buffer.from(chunk));
    perChunk.push(current);
    current = "";
  }
  redaction.end();
  return { perChunk, atEnd: current };
}

describe("redacting a secret from an answer", () => {
  it("passes each streamed event on at once, however long the secret", () => {
    const events = ['data: {"delta":"Hel"}\n\n', 'data: {"delta":"lo"}\n\n'];

    const { perChunk } = passThrough(longSecret, events);

    expect(perChunk).toEqual(events);
  });

  it("holds back only an end that could be the secret's start, until the next chunk says", () => {
    const { perChunk, atEnd } = passThrough(longSecret, ["before eyJaaa", "ok, after"]);

    expect(perChunk).toEqual(["before ", "eyJaaaok, after"]);
    expect(atEnd).toBe("");
  });

  it("replaces the secret split across chunks, wherever it is cut", () => {
    for (const cut of [1, 3, 500, longSecret.length - 1]) {
      const text = `x ${longSecret} y`;
      const { perChunk, atEnd } = passThrough(longSecret, [
        text.slice(0, cut + 2),
        text.slice(cut + 2),
      ]);

      expect(perChunk.join("") + atEnd).toBe(`x ${redactedSecretMarker} y`);
    }
  });

  it("gives out what it held back when the answer ends", () => {
    const { perChunk, atEnd } = passThrough("secret-key-0001", ["the end: secr"]);

    expect(perChunk).toEqual(["the end: "]);
    expect(atEnd).toBe("secr");
  });

  it("finds a start of the secret that repeats inside itself", () => {
    const { perChunk, atEnd } = passThrough("abab-c", ["xabab", "ab-c z"]);

    expect(perChunk.join("") + atEnd).toBe(`xab${redactedSecretMarker} z`);
  });
});
