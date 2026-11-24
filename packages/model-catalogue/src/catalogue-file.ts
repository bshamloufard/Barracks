import type { ModelCatalogue } from "@barrack/protocol";

/** Beside `src` and `dist` alike, so the sources and the build read the same file. */
export const catalogueFileUrl = new URL("../model-catalogue.json", import.meta.url);

/** The catalogue as it is written to its file: two-space JSON, ending in a line break. */
export function formatCatalogue(catalogue: ModelCatalogue): string {
  return `${JSON.stringify(catalogue, null, 2)}\n`;
}
