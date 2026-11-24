import type { ParseResult } from "@barrack/protocol";

/**
 * Reads the header of a Git bundle the sandbox sent, before Git touches it.
 * The bundle is hostile input: whatever the agent did, it may have shaped it.
 * Only what publishing needs is accepted: a version 2 or 3 bundle of SHA-1
 * objects that is not filtered (so it holds every object it names), whose
 * single reference is the thread's work branch.
 *
 * Format: https://git-scm.com/docs/gitformat-bundle
 *
 *     bundle    = signature *capability *prerequisite *reference LF pack
 *     signature = "# v2 git bundle" LF | "# v3 git bundle" LF
 *     capability   = "@" key ["=" value] LF
 *     prerequisite = "-" obj-id SP comment LF
 *     reference    = obj-id SP refname LF
 */

/** A header naming one reference and a few prerequisites is well under a kilobyte. */
export const maximumBundleHeaderLength = 64 * 1024;

export type BundleHeader = {
  prerequisites: string[];
  /** The commit the work branch points at in the bundle. */
  tipCommit: string;
  /** Where the pack, after the header, starts. */
  packOffset: number;
};

const objectIdPattern = /^[0-9a-f]{40}$/;
const signatures = new Set(["# v2 git bundle", "# v3 git bundle"]);

export function parseBundleHeader(
  start: Buffer,
  expectedReference: string,
): ParseResult<BundleHeader> {
  const headerEnd = start.indexOf("\n\n");
  if (headerEnd === -1 || headerEnd > maximumBundleHeaderLength) {
    return refuse("it is not a Git bundle, or its header is too long");
  }
  const [signature, ...lines] = start.subarray(0, headerEnd).toString("utf8").split("\n");
  if (signature === undefined || !signatures.has(signature)) {
    return refuse("it is not a version 2 or 3 Git bundle");
  }
  const prerequisites: string[] = [];
  const references: Array<{ objectId: string; name: string }> = [];
  for (const line of lines) {
    const problem = readLine(line, prerequisites, references);
    if (problem !== undefined) {
      return refuse(problem);
    }
  }
  const [reference, ...otherReferences] = references;
  if (
    reference === undefined ||
    otherReferences.length > 0 ||
    reference.name !== expectedReference
  ) {
    return refuse(`it must carry exactly one reference, ${expectedReference}`);
  }
  const packOffset = headerEnd + 2;
  if (start.subarray(packOffset, packOffset + 4).toString("latin1") !== "PACK") {
    return refuse("no pack follows its header");
  }
  return { ok: true, value: { prerequisites, tipCommit: reference.objectId, packOffset } };
}

function readLine(
  line: string,
  prerequisites: string[],
  references: Array<{ objectId: string; name: string }>,
): string | undefined {
  if (line.startsWith("@")) {
    return line === "@object-format=sha1"
      ? undefined
      : `it uses a capability Barrack does not accept (${line.slice(0, 40)})`;
  }
  if (line.startsWith("-")) {
    const objectId = line.slice(1, 41);
    if (!objectIdPattern.test(objectId)) {
      return "a prerequisite is not a commit name";
    }
    prerequisites.push(objectId);
    return undefined;
  }
  const separator = line.indexOf(" ");
  const objectId = line.slice(0, separator);
  if (separator === -1 || !objectIdPattern.test(objectId)) {
    return "a line of its header is not one Git writes";
  }
  references.push({ objectId, name: line.slice(separator + 1) });
  return undefined;
}

function refuse(reason: string): ParseResult<BundleHeader> {
  return { ok: false, errorMessage: `The sandbox's bundle was refused: ${reason}.` };
}
