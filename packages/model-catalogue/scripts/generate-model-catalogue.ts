import { writeFile } from "node:fs/promises";
import { catalogueFileUrl, formatCatalogue } from "../src/catalogue-file.js";
import { readAgentCatalogue } from "./read-agent-catalogue.js";

/**
 * Writes `model-catalogue.json` from the pinned Pi installed here. Run it
 * after changing the pinned version (`pnpm --filter @barrack/model-catalogue
 * generate`); a test fails until it has been.
 */
const catalogue = await readAgentCatalogue();
await writeFile(catalogueFileUrl, formatCatalogue(catalogue));
const modelCount = catalogue.providers.reduce(
  (count, provider) => count + provider.models.length,
  0,
);
process.stdout.write(
  `Wrote ${catalogue.providers.length} providers and ${modelCount} models from ${catalogue.agent.name} ${catalogue.agent.version}.\n`,
);
