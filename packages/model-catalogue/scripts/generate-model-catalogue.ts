import { writeFile } from "node:fs/promises";
import { catalogueFileUrl, formatCatalogue } from "../src/catalogue-file.js";
import { formatModelLimits, modelLimitsFileUrl } from "../src/model-limits-file.js";
import { readAgentCatalogue, readAgentModelLimits } from "./read-agent-catalogue.js";

/**
 * Writes `model-catalogue.json` and `model-limits.json` from the pinned Pi
 * installed here. Run it after changing the pinned version (`pnpm --filter
 * @barrack/model-catalogue generate`); a test fails until it has been.
 */
const catalogue = await readAgentCatalogue();
await writeFile(catalogueFileUrl, formatCatalogue(catalogue));
await writeFile(modelLimitsFileUrl, formatModelLimits(await readAgentModelLimits()));
const modelCount = catalogue.providers.reduce(
  (count, provider) => count + provider.models.length,
  0,
);
process.stdout.write(
  `Wrote ${catalogue.providers.length} providers and ${modelCount} models from ${catalogue.agent.name} ${catalogue.agent.version}, and the relayed providers' model limits.\n`,
);
