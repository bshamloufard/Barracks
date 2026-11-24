import { describe, expect, it } from "vitest";
import { z } from "zod";
import { maximumFrameLength } from "./limits.js";
import { parseFrame } from "./parse-frame.js";

const noteSchema = z.strictObject({ note: z.string() });

describe("parseFrame", () => {
  it("returns the decoded message when the frame matches the schema", () => {
    expect(parseFrame(noteSchema, '{"note":"hi"}')).toEqual({ ok: true, value: { note: "hi" } });
  });

  it("explains that a frame is not JSON instead of throwing", () => {
    expect(parseFrame(noteSchema, "{note")).toEqual({
      ok: false,
      errorMessage: expect.stringMatching(/^Frame is not valid JSON: /),
    });
  });

  it("names the offending field when the frame does not match the schema", () => {
    expect(parseFrame(noteSchema, '{"note":7}')).toEqual({
      ok: false,
      errorMessage: expect.stringContaining("note"),
    });
  });

  it("refuses a frame over the length limit before decoding it", () => {
    const oversizedFrame = `{"note":"${"x".repeat(maximumFrameLength)}"}`;

    expect(parseFrame(noteSchema, oversizedFrame)).toEqual({
      ok: false,
      errorMessage: expect.stringContaining(`the limit is ${maximumFrameLength}`),
    });
  });
});
