import {
  countTokens,
  type KeyPlacement,
  type ModelCatalogue,
  type ModelUsageSource,
  type ModelUsageTotals,
} from "@barrack/protocol";

const numberFormat = new Intl.NumberFormat("en");

export function formatTokens(tokens: number): string {
  return `${numberFormat.format(tokens)} tokens`;
}

/**
 * Where a provider's key lives, in the words the page uses beside it. A
 * provider the catalogue does not list (one the user named themselves)
 * keeps its key in the sandbox.
 */
export function describeKeyPlacement(placement: KeyPlacement): {
  label: string;
  explanation: string;
} {
  if (placement === "kept_on_server") {
    return {
      label: "Your key stays on the server",
      explanation:
        "The agent's requests to this provider go through Barrack's control plane, which adds your key; nothing in the sandbox can read it, and usage is measured there and counts towards your cap.",
    };
  }
  return {
    label: "Your key is placed in the sandbox",
    explanation:
      "The agent sends this provider's requests itself, so your key is placed in the thread's sandbox, where the agent and any code it runs can read it. Usage is only what the sandbox reports, and no cap can be enforced.",
  };
}

export function keyPlacementOf(
  catalogue: ModelCatalogue | undefined,
  providerId: string,
): KeyPlacement {
  const provider = catalogue?.providers.find((candidate) => candidate.providerId === providerId);
  return provider?.keyPlacement ?? "placed_in_sandbox";
}

/** How the numbers were counted, as the page says it. */
export function describeUsageSource(source: ModelUsageSource): string {
  switch (source) {
    case "measured":
      return "measured by Barrack";
    case "estimated":
      return "estimated by Barrack (answer cut short)";
    case "reported":
      return "reported by the sandbox, not verified";
  }
}

/** Tokens counted by Barrack itself, and tokens the sandbox reported, each added up. */
export function sumBySource(totals: readonly ModelUsageTotals[]): {
  counted: number;
  reported: number;
} {
  let counted = 0;
  let reported = 0;
  for (const total of totals) {
    if (total.source === "reported") {
      reported += countTokens(total);
    } else {
      counted += countTokens(total);
    }
  }
  return { counted, reported };
}

/** "120,000 tokens counted by Barrack, and 3,000 reported by the sandbox", or "No usage yet". */
export function describeUsageTotal(totals: readonly ModelUsageTotals[]): string {
  const { counted, reported } = sumBySource(totals);
  const parts = [
    ...(counted > 0 ? [`${formatTokens(counted)} counted by Barrack`] : []),
    ...(reported > 0 ? [`${formatTokens(reported)} reported by the sandbox`] : []),
  ];
  return parts.length === 0 ? "No usage yet" : parts.join(", and ");
}
