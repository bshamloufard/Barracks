import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { findAgentRequestShape, type ProviderApiFormat } from "@barrack/model-catalogue";
import { describe, expect, it } from "vitest";
import { inspectWholeBody } from "../test-support/request-bodies.js";
import { findUnrelayedHeaderValue } from "./proxy-headers.js";

/**
 * The model proxy relays only requests shaped like the pinned agent's, so
 * it must relay every request the agent sends. The model catalogue builds
 * them through the pinned Pi itself (`print-agent-requests.ts`, for every
 * model Pi lists for a relayed provider, at every thinking level and cache
 * retention, for conversations shaped like the coding agent's), which only
 * that package installs; here each is checked as the proxy checks a
 * request, its headers and its body as it would arrive.
 */

const catalogueDirectory = fileURLToPath(
  new URL("../../../../packages/model-catalogue/", import.meta.url),
);

type AgentRequest = {
  providerId: string;
  format: ProviderApiFormat;
  modelId: string;
  variant: string;
  headers: Record<string, string>;
  body: string;
};

async function* readAgentRequests(): AsyncGenerator<AgentRequest> {
  const printer = spawn(process.execPath, ["--import", "tsx", "scripts/print-agent-requests.ts"], {
    cwd: catalogueDirectory,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<number | null>((resolve) => printer.once("exit", resolve));
  for await (const line of createInterface({ input: printer.stdout })) {
    yield JSON.parse(line) as AgentRequest;
  }
  expect(await exited).toBe(0);
}

describe("the requests the pinned agent sends", () => {
  it("are every one relayed, in every relayed format to every relayed provider", {
    timeout: 300_000,
  }, async () => {
    let count = 0;
    const refused: string[] = [];
    const formatsSeen = new Set<string>();

    for await (const request of readAgentRequests()) {
      count += 1;
      formatsSeen.add(`${request.providerId} ${request.format}`);
      const shape = findAgentRequestShape(request.providerId, request.format);
      const header = shape && findUnrelayedHeaderValue(request.headers, shape);
      const inspection = inspectWholeBody(request.format, request.body, request.providerId);
      if (shape === undefined || header !== undefined || inspection.kind !== "relayable") {
        refused.push(
          `${request.providerId}/${request.modelId} (${request.variant}): ${header ?? JSON.stringify(inspection)}`,
        );
      }
    }

    expect(refused.slice(0, 5)).toEqual([]);
    expect(count).toBeGreaterThan(50_000);
    expect(formatsSeen.size).toBe(9);
  });
});
