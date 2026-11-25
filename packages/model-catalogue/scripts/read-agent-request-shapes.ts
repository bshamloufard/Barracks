import {
  type AgentRequestShapes,
  countPlaceholder,
  type FormatRequestShapes,
  type MemberRule,
  type ObjectType,
  type SettingItemRule,
  textPlaceholder,
} from "../src/agent-request-shapes-file.js";
import type { ProviderApiFormat } from "../src/relayed-providers.js";
import { type AgentRequest, buildAgentRequests } from "./agent-requests.js";
import { readPinnedAgentVersion } from "./read-agent-catalogue.js";

/**
 * Reads what the pinned Pi's requests hold (`agent-requests.ts`) into the
 * allow-list the model proxy relays against (`agent-request-shapes.json`),
 * with what it sends OpenAI on a ChatGPT plan kept apart:
 * every top-level member and each value it took, the `type` of every object
 * at each place the format gives a meaning to, every `anthropic-beta`
 * value, and every member of the conversation items that carry settings
 * and each value it took. Nothing is added by hand: what Pi does not send
 * is not on it.
 *
 * The places are those the proxy's scanner finds as a body arrives
 * (`json-body-scanner.ts` in the control plane), found here from the parsed
 * body by the same rules: the conversation's items; the parts of an item's
 * `content` or `output`, and of a part's `content`; an image part's source (Anthropic's `source`, Chat Completions'
 * `image_url` object); the tools, at the top level or in an item; the `tool`
 * of a part, and that tool's `definition`; and a `cache_control` on a part
 * or a tool.
 */
export async function readAgentRequestShapes(): Promise<{
  shapes: AgentRequestShapes;
  requestCount: number;
}> {
  const collected = new Map<ProviderApiFormat, CollectedFormat>();
  const collectedOnPlan = emptyCollection();
  let requestCount = 0;
  await buildAgentRequests((request) => {
    requestCount += 1;
    if (request.access === "chatgpt_plan") {
      collectRequest(collectedOnPlan, request);
      return;
    }
    const format = collected.get(request.format) ?? emptyCollection();
    collected.set(request.format, format);
    collectRequest(format, request);
  });
  const formats = {} as AgentRequestShapes["formats"];
  for (const format of [
    "anthropic_messages",
    "openai_responses",
    "openai_chat_completions",
  ] as const) {
    formats[format] = finishCollection(format, collected.get(format) ?? emptyCollection());
  }
  return {
    shapes: {
      agent: { name: "Pi", version: await readPinnedAgentVersion() },
      formats,
      chatgptPlan: finishCollection("openai_responses", collectedOnPlan),
    },
    requestCount,
  };
}

/** The top-level members the proxy checks as they arrive rather than parsing them. */
export const scannedMembers: Readonly<Record<ProviderApiFormat, readonly string[]>> = {
  anthropic_messages: ["messages", "system", "tools"],
  openai_responses: ["input", "tools"],
  openai_chat_completions: ["messages", "tools"],
};

/** Members whose text is an identifier of the request's own, never a setting: any text will do. */
const freeTextMembers = new Set(["model", "prompt_cache_key"]);

/**
 * The conversation items that carry settings the provider honours, as Pi's
 * request builders write them (pi-ai's `anthropic-messages.js` and
 * `openai-responses-shared.js`): Anthropic's system message mid-conversation,
 * which carries `output_config` (the effort of the replies after it) or a
 * tool change; the Responses API's `configuration_update`, which carries
 * `reasoning`; and its `additional_tools`, which declares tools. Their
 * members are checked as the top level's are, so that a setting Pi never
 * puts there cannot be given there instead. Every other item, part and tool
 * Pi sends is checked by its `type` alone (see `docs/decisions.md`).
 */
export const settingItemKinds: Readonly<
  Record<ProviderApiFormat, ReadonlyArray<Pick<SettingItemRule, "kindMember" | "kind">>>
> = {
  anthropic_messages: [{ kindMember: "role", kind: "system" }],
  openai_responses: [
    { kindMember: "type", kind: "configuration_update" },
    { kindMember: "type", kind: "additional_tools" },
  ],
  openai_chat_completions: [],
};

/** Members of a setting item the proxy checks as they arrive, by the types of what they hold. */
const scannedItemMembers = new Set(["content", "output", "tools"]);

type TypeLists = Omit<
  FormatRequestShapes,
  "betaHeaderValues" | "membersByProvider" | "settingItems"
>;
type Place = keyof TypeLists;

/** By member, the distinct values as JSON. */
type CollectedMembers = Map<string, Set<string>>;

type CollectedFormat = {
  types: Record<Place, Set<ObjectType>>;
  betaHeaderValues: Set<string>;
  /** By provider, then member. */
  members: Map<string, CollectedMembers>;
  /** By the index of its kind in `settingItemKinds`, then member. */
  settingItems: Map<number, CollectedMembers>;
};

function emptyCollection(): CollectedFormat {
  return {
    types: {
      itemTypes: new Set(),
      partTypes: new Set(),
      imageSourceTypes: new Set(),
      toolTypes: new Set(),
      toolChangeTypes: new Set(),
      cacheControlTypes: new Set(),
    },
    betaHeaderValues: new Set(),
    members: new Map(),
    settingItems: new Map(),
  };
}

function collectRequest(collected: CollectedFormat, request: AgentRequest): void {
  for (const value of (request.headers["anthropic-beta"] ?? "").split(",")) {
    if (value.trim() !== "") {
      collected.betaHeaderValues.add(value.trim());
    }
  }
  const body = JSON.parse(request.body) as Record<string, unknown>;
  const members = collected.members.get(request.providerId) ?? new Map<string, Set<string>>();
  collected.members.set(request.providerId, members);
  for (const [name, value] of Object.entries(body)) {
    noteValue(members, name, describeValue(request.format, name, value));
  }
  walkTopLevel(request.format, body, (place, type) => collected.types[place].add(type));
  collectSettingItems(collected, request.format, body);
}

function collectSettingItems(
  collected: CollectedFormat,
  format: ProviderApiFormat,
  body: Record<string, unknown>,
): void {
  const kinds = settingItemKinds[format];
  for (const item of objectsIn(body[conversationKey(format)])) {
    const index = kinds.findIndex(({ kindMember, kind }) => item[kindMember] === kind);
    const kindMember = kinds[index]?.kindMember;
    if (kindMember === undefined) {
      continue;
    }
    const members = collected.settingItems.get(index) ?? new Map<string, Set<string>>();
    collected.settingItems.set(index, members);
    for (const [name, value] of Object.entries(item)) {
      const isScanned = name === kindMember || scannedItemMembers.has(name);
      noteValue(members, name, isScanned ? "scanned" : replaceCounts(value));
    }
  }
}

function noteValue(members: CollectedMembers, name: string, value: unknown): void {
  const values = members.get(name) ?? new Set<string>();
  members.set(name, values);
  values.add(JSON.stringify(value));
}

function conversationKey(format: ProviderApiFormat): string {
  return format === "openai_responses" ? "input" : "messages";
}

function describeValue(format: ProviderApiFormat, name: string, value: unknown): unknown {
  if (scannedMembers[format].includes(name)) {
    return "scanned";
  }
  if (freeTextMembers.has(name) && typeof value === "string") {
    return textPlaceholder;
  }
  return replaceCounts(value);
}

/** The value with each whole number from zero up replaced by `<count>`. */
function replaceCounts(value: unknown): unknown {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return countPlaceholder;
  }
  if (Array.isArray(value)) {
    return value.map(replaceCounts);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, replaceCounts(nested)]),
    );
  }
  return value;
}

type NoteType = (place: Place, type: ObjectType) => void;

/** Finds the objects at each place a format gives a meaning to, as the proxy's scanner does. */
export function walkTopLevel(
  format: ProviderApiFormat,
  body: Record<string, unknown>,
  noteType: NoteType,
): void {
  for (const item of objectsIn(body[conversationKey(format)])) {
    walkObject(format, "itemTypes", item, noteType);
  }
  for (const tool of objectsIn(body["tools"])) {
    walkObject(format, "toolTypes", tool, noteType);
  }
}

function walkObject(
  format: ProviderApiFormat,
  place: Place,
  object: Record<string, unknown>,
  noteType: NoteType,
): void {
  noteType(place, typeOf(object));
  for (const [key, value] of Object.entries(object)) {
    const inner = placeInside(format, place, key, value);
    if (inner === undefined) {
      continue;
    }
    const objects = Array.isArray(value) ? objectsIn(value) : [value as Record<string, unknown>];
    for (const nested of objects) {
      walkObject(format, inner, nested, noteType);
    }
  }
}

/** Where an array or object under `key` lies, from where its parent lies; undefined for nowhere in particular. */
function placeInside(
  format: ProviderApiFormat,
  place: Place,
  key: string,
  value: unknown,
): Place | undefined {
  const isArray = Array.isArray(value);
  const isObject = typeof value === "object" && value !== null && !isArray;
  switch (place) {
    case "itemTypes":
      if (isArray && (key === "content" || key === "output")) return "partTypes";
      if (isArray && key === "tools") return "toolTypes";
      return undefined;
    case "partTypes":
      if (isArray && key === "content") return "partTypes";
      if (isObject && key === imageSourceKey(format)) return "imageSourceTypes";
      if (isObject && key === "tool") return "toolChangeTypes";
      if (isObject && key === "cache_control") return "cacheControlTypes";
      return undefined;
    case "toolTypes":
      return isObject && key === "cache_control" ? "cacheControlTypes" : undefined;
    case "toolChangeTypes":
      return isObject && key === "definition" ? "toolTypes" : undefined;
    default:
      return undefined;
  }
}

function imageSourceKey(format: ProviderApiFormat): string | undefined {
  switch (format) {
    case "anthropic_messages":
      return "source";
    case "openai_chat_completions":
      return "image_url";
    case "openai_responses":
      return undefined;
  }
}

function typeOf(object: Record<string, unknown>): ObjectType {
  const type = object["type"];
  if (type === undefined) {
    return null;
  }
  return typeof type === "string" ? type : "<not text>";
}

function objectsIn(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

function finishCollection(
  format: ProviderApiFormat,
  collected: CollectedFormat,
): FormatRequestShapes {
  const membersByProvider: FormatRequestShapes["membersByProvider"] = {};
  for (const providerId of [...collected.members.keys()].sort()) {
    membersByProvider[providerId] = finishMembers(collected.members.get(providerId));
  }
  return {
    itemTypes: sortedTypes(collected.types.itemTypes),
    partTypes: sortedTypes(collected.types.partTypes),
    imageSourceTypes: sortedTypes(collected.types.imageSourceTypes),
    toolTypes: sortedTypes(collected.types.toolTypes),
    toolChangeTypes: sortedTypes(collected.types.toolChangeTypes),
    cacheControlTypes: sortedTypes(collected.types.cacheControlTypes),
    betaHeaderValues: [...collected.betaHeaderValues].sort(),
    membersByProvider,
    settingItems: settingItemKinds[format].map((kind, index) => ({
      ...kind,
      members: finishMembers(collected.settingItems.get(index)),
    })),
  };
}

function finishMembers(members: CollectedMembers | undefined): Record<string, MemberRule> {
  const collected = members ?? new Map<string, Set<string>>();
  return Object.fromEntries(
    [...collected.keys()].sort().map((name) => {
      const values = [...(collected.get(name) ?? [])].sort();
      return [
        name,
        values.length === 1 && values[0] === '"scanned"'
          ? "scanned"
          : values.map((value) => JSON.parse(value)),
      ];
    }),
  );
}

/** `null` (no `type`) first, then the types in order. */
function sortedTypes(types: Set<ObjectType>): ObjectType[] {
  const named = [...types].filter((type): type is string => type !== null).sort();
  return types.has(null) ? [null, ...named] : named;
}
