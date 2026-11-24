import { describe, expect, it } from "vitest";
import {
  parsePageAddress,
  parsePageLocation,
  settingsAddress,
  threadPageAddress,
} from "./page-address";

describe("the settings and GitHub's callback", () => {
  it("are the settings page at its address", () => {
    expect(parsePageAddress(new URL(settingsAddress, "http://localhost").search)).toEqual({
      ok: true,
      value: { page: "settings" },
    });
  });

  it("are GitHub's callback, by its path, with the code and state GitHub added", () => {
    expect(parsePageLocation("/github/callback", "?code=abc&state=xyz")).toEqual({
      ok: true,
      value: { page: "github-callback", code: "abc", state: "xyz" },
    });
    expect(parsePageLocation("/github/callback", "?installation_id=1").ok).toBe(false);
  });

  it("read any other path's page from its query, as before", () => {
    expect(parsePageLocation("/", "?thread=thread-1")).toEqual({
      ok: true,
      value: { page: "thread", threadId: "thread-1" },
    });
  });
});

describe("the page named in the address", () => {
  it("is the thread list when the address names no thread", () => {
    expect(parsePageAddress("")).toEqual({ ok: true, value: { page: "thread-list" } });
  });

  it("is the thread named by ?thread=", () => {
    expect(parsePageAddress("?thread=0b9e5b8c-2f7d-4a37-9d43-6a1f1b0f2a11")).toEqual({
      ok: true,
      value: { page: "thread", threadId: "0b9e5b8c-2f7d-4a37-9d43-6a1f1b0f2a11" },
    });
  });

  it("is the thread a thread page's address names", () => {
    const address = threadPageAddress("my-thread_2");

    expect(parsePageAddress(new URL(address, "http://localhost").search)).toEqual({
      ok: true,
      value: { page: "thread", threadId: "my-thread_2" },
    });
  });

  it.each([
    ["is empty", "?thread="],
    ["contains a path separator", "?thread=..%2Fsecrets"],
    ["contains a space", "?thread=my%20thread"],
    ["is longer than 64 characters", `?thread=${"a".repeat(65)}`],
  ])("is refused with an explanation when the thread %s", (_, queryString) => {
    expect(parsePageAddress(queryString)).toEqual({
      ok: false,
      errorMessage: expect.stringContaining("1 to 64 letters, digits, underscores or hyphens"),
    });
  });
});
