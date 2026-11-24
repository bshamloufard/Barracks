import { describe, expect, it } from "vitest";
import { parseThreadIdFromAddress } from "./thread-address";

describe("the thread named in the page address", () => {
  it("is the value of ?thread=", () => {
    expect(parseThreadIdFromAddress("?thread=my-thread_2")).toEqual({
      ok: true,
      value: "my-thread_2",
    });
  });

  it("is the local thread when the address names none", () => {
    expect(parseThreadIdFromAddress("")).toEqual({ ok: true, value: "local" });
  });

  it.each([
    ["is empty", "?thread="],
    ["contains a path separator", "?thread=..%2Fsecrets"],
    ["contains a space", "?thread=my%20thread"],
    ["is longer than 64 characters", `?thread=${"a".repeat(65)}`],
  ])("is refused with an explanation when it %s", (_, queryString) => {
    expect(parseThreadIdFromAddress(queryString)).toEqual({
      ok: false,
      errorMessage: expect.stringContaining("1 to 64 letters, digits, underscores or hyphens"),
    });
  });
});
