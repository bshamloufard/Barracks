import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The repository's Markdown files link to each other and to source files by
 * relative paths, which break silently when a file is moved, split or
 * renamed, or a heading is reworded. This test fails on a relative link to
 * a file that does not exist, or to a heading a Markdown file does not
 * have. It lives here beside `deployment-guide.test.ts`, the other check on
 * the documentation, because the workspace's tests run per package.
 */

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Directories that hold no documentation of ours: dependencies, build output, and dot-directories (Git, local sandboxes). */
function isSkippedDirectory(name: string): boolean {
  return name === "node_modules" || name === "dist" || name.startsWith(".");
}

function markdownFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return isSkippedDirectory(entry.name) ? [] : markdownFilesUnder(entryPath);
    }
    return entry.name.endsWith(".md") ? [entryPath] : [];
  });
}

/** The text a reader sees as prose: fenced code blocks and inline code removed. */
function proseOf(markdown: string): string {
  return markdown.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
}

/** The anchors GitHub gives a file's headings, `#a-heading` for "A heading". */
function headingAnchorsOf(markdownFile: string): Set<string> {
  const anchors = new Set<string>();
  const timesSeen = new Map<string, number>();
  const markdown = readFileSync(markdownFile, "utf8").replace(/^```[\s\S]*?^```/gm, "");
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const anchor = (match[1] ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const seen = timesSeen.get(anchor) ?? 0;
    anchors.add(seen === 0 ? anchor : `${anchor}-${seen}`);
    timesSeen.set(anchor, seen + 1);
  }
  return anchors;
}

/** Every relative link in a Markdown file that leads nowhere, as `file: target`. */
function brokenLinksIn(markdownFile: string): string[] {
  const prose = proseOf(readFileSync(markdownFile, "utf8"));
  const targets = [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? "");
  return targets
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target))
    .filter((target) => !linkResolves(markdownFile, target))
    .map((target) => `${path.relative(repositoryRoot, markdownFile)}: ${target}`);
}

function linkResolves(markdownFile: string, target: string): boolean {
  const [targetPath = "", anchor] = target.split("#");
  const resolved =
    targetPath === "" ? markdownFile : path.resolve(path.dirname(markdownFile), targetPath);
  if (!existsSync(resolved)) {
    return false;
  }
  if (anchor === undefined || anchor === "" || !resolved.endsWith(".md")) {
    return true;
  }
  return headingAnchorsOf(resolved).has(anchor);
}

describe("the repository's Markdown files", () => {
  it("are found", () => {
    const files = markdownFilesUnder(repositoryRoot).map((file) =>
      path.relative(repositoryRoot, file),
    );

    expect(files).toContain("README.md");
    expect(files).toContain(path.join("docs", "deployment.md"));
  });

  it("link only to files and headings that exist", () => {
    const broken = markdownFilesUnder(repositoryRoot).flatMap(brokenLinksIn);

    expect(broken).toEqual([]);
  });
});
