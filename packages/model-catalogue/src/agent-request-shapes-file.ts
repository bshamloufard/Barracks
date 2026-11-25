import type { ProviderApiFormat } from "./relayed-providers.js";

/**
 * What the pinned agent's requests to the relayed providers may hold, as
 * generated from the agent itself (see `scripts/read-agent-request-shapes.ts`):
 * the one list the control plane's model proxy relays against, so that it
 * relays only requests shaped like the agent's own.
 *
 * Per wire format, the `type` an object may have at each place where the
 * format puts its conversation's items, their parts and the tools (`null`
 * where the agent sends such an object without a `type`), Anthropic's
 * `anthropic-beta` header values, and the members of the conversation
 * items that carry settings; and, per provider, each top-level member the
 * agent sends and the values it may hold.
 */
export type AgentRequestShapes = {
  agent: { name: string; version: string };
  formats: Record<ProviderApiFormat, FormatRequestShapes>;
};

/** The `type` of an object at a place the format gives a meaning to; `null` for none. */
export type ObjectType = string | null;

export type FormatRequestShapes = {
  /** Each item of the conversation (`messages`, or the Responses API's `input`). */
  itemTypes: ObjectType[];
  /** Each part of an item's `content` or `output`, or of a part's `content`. */
  partTypes: ObjectType[];
  /** The object holding an image part's image: Anthropic's `source`, Chat Completions' `image_url`. */
  imageSourceTypes: ObjectType[];
  /** Each tool, at the top level or declared in a conversation item. */
  toolTypes: ObjectType[];
  /** The `tool` of an Anthropic part adding or removing a tool mid-conversation. */
  toolChangeTypes: ObjectType[];
  /** A prompt cache marker (`cache_control`) on a part or a tool. */
  cacheControlTypes: ObjectType[];
  /** Each value of the `anthropic-beta` header. */
  betaHeaderValues: string[];
  /** The top-level members each provider's requests in this format may have. */
  membersByProvider: Record<string, Record<string, MemberRule>>;
  /** The conversation items that carry settings, and what each may hold. */
  settingItems: SettingItemRule[];
};

/**
 * A kind of conversation item that carries settings the provider honours,
 * such as how hard to reason, so that its members are checked as the top
 * level's are: the item is known by the value of one of its members (its
 * `type`, or for Anthropic its `role`), and may have only the members
 * listed, each holding what `members` allows (`scanned` for its kind and for
 * the parts or tools it holds, which the proxy checks as they arrive).
 */
export type SettingItemRule = {
  kindMember: "type" | "role";
  kind: string;
  members: Record<string, MemberRule>;
};

/**
 * What a top-level member may hold: `scanned` for the conversation, the
 * tools and Anthropic's `system`, which the proxy checks as they arrive
 * (the first two by the types above, `system` for its grammar alone, since
 * Anthropic takes only text there); otherwise one of the values listed, where the text
 * `<count>` stands for any whole number from zero up and `<text>` for any
 * text.
 */
export type MemberRule = "scanned" | readonly unknown[];

export const countPlaceholder = "<count>";
export const textPlaceholder = "<text>";

/** Beside `src` and `dist` alike, so the sources and the build read the same file. */
export const agentRequestShapesFileUrl = new URL("../agent-request-shapes.json", import.meta.url);
