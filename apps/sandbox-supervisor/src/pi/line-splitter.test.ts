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
});
