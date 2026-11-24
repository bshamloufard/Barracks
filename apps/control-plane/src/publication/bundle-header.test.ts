import { describe, expect, it } from "vitest";
import { maximumBundleHeaderLength, parseBundleHeader } from "./bundle-header.js";

/**
 * The header of a bundle the sandbox sent is read before Git sees the
 * bundle at all; anything but what publishing needs is refused there.
 * Whole bundles, including ones too large and ones Git itself refuses, are
 * tested through publishing in `publication.test.ts`.
 */

const workBranch = "refs/heads/barrack/thread-1";
const tip = "a".repeat(40);
const base = "b".repeat(40);

function bundle(
  headerLines: readonly string[],
  afterHeader = "PACK\u0000\u0000\u0000\u0002",
): Buffer {
  return Buffer.from(`${headerLines.join("\n")}\n\n${afterHeader}`, "latin1");
}

describe("a publication bundle's header", () => {
  it("is accepted with the work branch as its one reference, giving its tip, prerequisites and pack", () => {
    const start = bundle([
      "# v3 git bundle",
      "@object-format=sha1",
      `-${base} base`,
      `${tip} ${workBranch}`,
    ]);

    const header = parseBundleHeader(start, workBranch);

    expect(header).toEqual({
      ok: true,
      value: { prerequisites: [base], tipCommit: tip, packOffset: start.indexOf("PACK") },
    });
  });

  it.each([
    [
      "a filtered bundle, which lacks objects it names",
      ["# v3 git bundle", "@filter=blob:none", `${tip} ${workBranch}`],
      "capability",
    ],
    [
      "a bundle of SHA-256 objects",
      ["# v3 git bundle", "@object-format=sha256", `${tip} ${workBranch}`],
      "capability",
    ],
    [
      "a second reference",
      ["# v2 git bundle", `${tip} ${workBranch}`, `${tip} refs/heads/main`],
      "exactly one reference",
    ],
    [
      "a tag in place of the work branch",
      ["# v2 git bundle", `${tip} refs/tags/barrack/thread-1`],
      "exactly one reference",
    ],
    ["no reference at all", ["# v2 git bundle", `-${base} base`], "exactly one reference"],
    ["a line Git never writes", ["# v2 git bundle", `${tip}${workBranch}`], "not one Git writes"],
    [
      "a version Barrack does not read",
      ["# v4 git bundle", `${tip} ${workBranch}`],
      "version 2 or 3",
    ],
  ])("is refused for %s", (_description, headerLines, reason) => {
    const header = parseBundleHeader(bundle(headerLines), workBranch);

    expect(header).toEqual({ ok: false, errorMessage: expect.stringContaining(reason) });
  });

  it("is refused when no pack follows it", () => {
    const header = parseBundleHeader(
      bundle(["# v2 git bundle", `${tip} ${workBranch}`], "junk"),
      workBranch,
    );

    expect(header).toEqual({ ok: false, errorMessage: expect.stringContaining("no pack") });
  });

  it("is refused when it does not end within the length it may have, however it goes on", () => {
    const prerequisites = Array.from(
      { length: Math.ceil(maximumBundleHeaderLength / 40) },
      () => `-${base} base`,
    );
    const start = bundle(["# v2 git bundle", ...prerequisites, `${tip} ${workBranch}`]);

    const header = parseBundleHeader(start, workBranch);

    expect(header).toEqual({ ok: false, errorMessage: expect.stringContaining("too long") });
  });
});
