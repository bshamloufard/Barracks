import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { agentRequestShapesFileUrl } from "../src/agent-request-shapes-file.js";
import { catalogueFileUrl, formatCatalogue } from "../src/catalogue-file.js";
import { formatModelLimits, modelLimitsFileUrl } from "../src/model-limits-file.js";
import { readAgentCatalogue, readAgentModelLimits } from "./read-agent-catalogue.js";
import { readAgentRequestShapes } from "./read-agent-request-shapes.js";

/**
 * Writes `model-catalogue.json`, `model-limits.json` and
 * `agent-request-shapes.json` from the pinned Pi installed here. Run it
 * after changing the pinned version (`pnpm --filter
 * @barrack/model-catalogue generate`); a test fails until it has been.
 */
const catalogue = await readAgentCatalogue();
await writeFile(catalogueFileUrl, formatCatalogue(catalogue));
await writeFile(modelLimitsFileUrl, formatModelLimits(await readAgentModelLimits()));
const { shapes, requestCount } = await readAgentRequestShapes();
await writeFile(agentRequestShapesFileUrl, JSON.stringify(shapes));
// Written as the repository's formatter writes JSON, so the lint passes; the test compares values.
execFileSync(
  "pnpm",
  ["exec", "biome", "format", "--write", fileURLToPath(agentRequestShapesFileUrl)],
  { stdio: "ignore" },
);
const modelCount = catalogue.providers.reduce(
  (count, provider) => count + provider.models.length,
  0,
);
process.stdout.write(
  `Wrote ${catalogue.providers.length} providers and ${modelCount} models from ${catalogue.agent.name} ${catalogue.agent.version}, the relayed providers' model limits, and the shapes of the ${requestCount} requests it was made to send them.\n`,
);
