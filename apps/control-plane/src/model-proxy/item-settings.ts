import { type AgentRequestShape, isAllowedValue } from "@barrack/model-catalogue";
import type { ItemSetting } from "./json-body-scanner.js";

/**
 * The settings a request gives inside the conversation items that carry
 * them (Anthropic's system message, the Responses API's
 * `configuration_update` and `additional_tools`), as the scanner kept them,
 * each different one once and few bytes in all (`json-body-scanner.ts`),
 * parsed and checked as the top level's are: each must hold one of the
 * values the agent gives that member in that kind of item. Each must also
 * be written as the agent writes it (as `JSON.stringify` writes it: no
 * spaces, escapes or repeated keys), since these are relayed as received,
 * not written out again: so every decoder reads what was checked.
 */
export function readItemSettings(
  shape: AgentRequestShape,
  settings: readonly ItemSetting[],
): { kind: "read"; settings: Array<Record<string, unknown>> } | { kind: "refused"; what: string } {
  const read: Array<Record<string, unknown>> = [];
  for (const { kind, member, text } of settings) {
    const rule = shape.settingItems.find((item) => item.kind === kind)?.members[member];
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(rule) || JSON.stringify(value) !== text || !isAllowedValue(rule, value)) {
      return { kind: "refused", what: `the value given for \`${member}\` in a \`${kind}\` item` };
    }
    read.push({ [member]: value });
  }
  return { kind: "read", settings: read };
}
