import { describe, expect, it } from "vitest";
import { LineSplitter } from "./line-splitter.js";

describe("LineSplitter", () => {
  it("holds back a line split across chunks until its line feed arrives", () => {
    const splitter = new LineSplitter();

    expect(splitter.push(Buffer.from('{"type":"agent_'))).toEqual([]);
    expect(splitter.push(Buffer.from('start"}\n'))).toEqual(['{"type":"agent_start"}']);
  });

  it("returns every line completed by a single chunk, in order", () => {
    const splitter = new LineSplitter();

    expect(splitter.push(Buffer.from('{"n":1}\n{"n":2}\n{"n":3'))).toEqual(['{"n":1}', '{"n":2}']);
    expect(splitter.push(Buffer.from("}\n"))).toEqual(['{"n":3}']);
  });

  it("does not split a line at U+2028 or U+2029 inside a JSON string", () => {
    const splitter = new LineSplitter();
    const line = JSON.stringify({ delta: "before between after" });

    const lines = splitter.push(Buffer.from(`${line}\n`));

    expect(lines).toEqual([line]);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ delta: "before between after" });
  });

  it("keeps a multi-byte character intact when a chunk boundary falls inside it", () => {
    const splitter = new LineSplitter();
    const bytes = Buffer.from('{"text":"é"}\n');
    const boundary = bytes.indexOf(0xc3) + 1;

    splitter.push(bytes.subarray(0, boundary));
    const lines = splitter.push(bytes.subarray(boundary));

    expect(lines).toEqual(['{"text":"é"}']);
  });

  it("removes a carriage return before the line feed", () => {
    const splitter = new LineSplitter();

    expect(splitter.push(Buffer.from('{"n":1}\r\n'))).toEqual(['{"n":1}']);
  });

  it("reports how many bytes of an unfinished line it holds", () => {
    const splitter = new LineSplitter();

    splitter.push(Buffer.from('{"n":1}\n{"n"'));

    expect(splitter.unfinishedLineLength).toBe(4);
  });

  // Joining the held bytes on every chunk made this take over a minute. It
  // is the shape of Pi's `agent_end` record after a run with screenshots.
  it("reassembles a multi-megabyte line that arrives in many small chunks", () => {
    const splitter = new LineSplitter();
    const line = JSON.stringify({ type: "agent_end", image: "A".repeat(16 * 1024 * 1024) });
    const bytes = Buffer.from(`${line}\n{"n":2}\n`);
    const chunkLength = 1024;

    const lines: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += chunkLength) {
      lines.push(...splitter.push(bytes.subarray(offset, offset + chunkLength)));
    }

    expect(lines).toHaveLength(2);
    expect(lines[0] === line).toBe(true);
    expect(lines[1]).toBe('{"n":2}');
    expect(splitter.unfinishedLineLength).toBe(0);
  });

  it("keeps only the start of a line longer than its limit and marks what it left out", () => {
    const splitter = new LineSplitter({ maximumLineLengthInBytes: 10 });

    splitter.push(Buffer.from("0123456"));
    const lines = splitter.push(Buffer.from("789abcdef\nshort\n"));

    expect(lines).toEqual(["0123456789 [… 6 more bytes not kept]", "short"]);
  });

  it("counts the bytes it left out of an unfinished line as held", () => {
    const splitter = new LineSplitter({ maximumLineLengthInBytes: 4 });

    splitter.push(Buffer.from("0123456789"));

    expect(splitter.unfinishedLineLength).toBe(10);
  });
});
