import { readFileSync } from "node:fs";
import {
  type AgentRequestShapes,
  agentRequestShapesFileUrl,
  countPlaceholder,
  type FormatRequestShapes,
  type MemberRule,
  textPlaceholder,
} from "./agent-request-shapes-file.js";
import type { ProviderApiFormat } from "./relayed-providers.js";

const shapes = parseAgentRequestShapes(JSON.parse(readFileSync(agentRequestShapesFileUrl, "utf8")));

/** What one provider's requests in one format may hold (see `agent-request-shapes-file.ts`). */
export type AgentRequestShape = Omit<FormatRequestShapes, "membersByProvider"> & {
  members: Readonly<Record<string, MemberRule>>;
};

/**
 * What the pinned agent's requests to `providerId` in `format` may hold,
 * or undefined if it sends that provider no request in that format. Read
 * and checked once, when first imported.
 */
export function findAgentRequestShape(
  providerId: string,
  format: ProviderApiFormat,
): AgentRequestShape | undefined {
  const { membersByProvider, ...types } = shapes.formats[format];
  const members = Object.hasOwn(membersByProvider, providerId)
    ? membersByProvider[providerId]
    : undefined;
  return members === undefined ? undefined : { ...types, members };
}

/** Whether `value` is one the rule lists, `<count>` standing for any whole number from zero up and `<text>` for any text. */
export function isAllowedValue(allowed: readonly unknown[], value: unknown): boolean {
  return allowed.some((shape) => matchesShape(shape, value));
}

function matchesShape(shape: unknown, value: unknown): boolean {
  if (shape === countPlaceholder) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }
  if (shape === textPlaceholder) {
    return typeof value === "string";
  }
  if (Array.isArray(shape)) {
    return (
      Array.isArray(value) &&
      value.length === shape.length &&
      shape.every((item, index) => matchesShape(item, value[index]))
    );
  }
  if (typeof shape === "object" && shape !== null) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const shapeKeys = Object.keys(shape);
    const valueKeys = Object.keys(value);
    return (
      valueKeys.length === shapeKeys.length &&
      shapeKeys.every(
        (key) =>
          Object.hasOwn(value, key) &&
          matchesShape(
            (shape as Record<string, unknown>)[key],
            (value as Record<string, unknown>)[key],
          ),
      )
    );
  }
  return shape === value;
}

function parseAgentRequestShapes(file: unknown): AgentRequestShapes {
  const formats = (file as Partial<AgentRequestShapes> | null)?.formats;
  for (const format of ["anthropic_messages", "openai_responses", "openai_chat_completions"]) {
    const shape = (formats as Record<string, Partial<FormatRequestShapes>> | undefined)?.[format];
    const lists = [
      shape?.itemTypes,
      shape?.partTypes,
      shape?.imageSourceTypes,
      shape?.toolTypes,
      shape?.toolChangeTypes,
      shape?.cacheControlTypes,
      shape?.betaHeaderValues,
    ];
    if (
      !lists.every(Array.isArray) ||
      !Array.isArray(shape?.settingItems) ||
      typeof shape?.membersByProvider !== "object" ||
      shape.membersByProvider === null
    ) {
      throw new Error(`agent-request-shapes.json is not as generated, at ${format}`);
    }
  }
  return file as AgentRequestShapes;
}
