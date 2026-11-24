import { describe, expect, it } from "vitest";
import { findDescendants, parseProcessTable } from "./list-descendant-process-ids.js";

describe("parseProcessTable", () => {
  it("reads process and parent IDs from ps output, skipping anything else", () => {
    expect(parseProcessTable("    1     0\n  20     1\n\nnot a row\n")).toEqual([
      { processId: 1, parentProcessId: 0 },
      { processId: 20, parentProcessId: 1 },
    ]);
  });
});

describe("findDescendants", () => {
  it("finds children, grandchildren and beyond, but not the process itself or its relatives", () => {
    const processTable = [
      { processId: 1, parentProcessId: 0 },
      { processId: 10, parentProcessId: 1 },
      { processId: 11, parentProcessId: 10 },
      { processId: 12, parentProcessId: 11 },
      { processId: 13, parentProcessId: 10 },
      { processId: 20, parentProcessId: 1 },
    ];

    expect(new Set(findDescendants(10, processTable))).toEqual(new Set([11, 12, 13]));
  });
});
