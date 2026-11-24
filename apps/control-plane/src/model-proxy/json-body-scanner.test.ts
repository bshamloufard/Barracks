import { findAgentRequestShape, type ProviderApiFormat } from "@barrack/model-catalogue";
import { describe, expect, it } from "vitest";
import { JsonBodyScanner, type JsonScanOutcome } from "./json-body-scanner.js";
import { requestBodyShapeLimits } from "./request-body.js";

/**
 * Scans `text` split into chunks of `chunkSize` bytes, as a body arriving
 * in pieces would be; against the agent's requests to `providerId` if
 * given, otherwise for its grammar and images alone.
 */
function scan(
  text: string | Buffer,
  chunkSize = 7,
  format: ProviderApiFormat = "anthropic_messages",
  providerId?: string,
): JsonScanOutcome {
  const bytes = typeof text === "string" ? Buffer.from(text) : text;
  const shape = providerId === undefined ? undefined : findAgentRequestShape(providerId, format);
  const scanner = new JsonBodyScanner(requestBodyShapeLimits, format, shape);
  for (let start = 0; start < bytes.length; start += chunkSize) {
    scanner.write(bytes.subarray(start, start + chunkSize));
  }
  return scanner.finish();
}

function isObjectByJsonParse(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

const validObjects = [
  "{}",
  ' { "a" : 1 } ',
  '{"a":[1,-2,3.5,-0,0.25e10,1E-3,2e+2,true,false,null,"x"],"b":{"c":{"d":[]}}}',
  '{"escapes":"\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\uD83D\\uDE00","unicode":"é漢😀"}',
  '{"model":"m","model2":"m"}',
  '{\n\t"a":\r\n[ ]\n}',
];

const invalidBodies = [
  "",
  " ",
  "[]",
  '"text"',
  "1",
  "{",
  '{"a":}',
  '{"a" 1}',
  '{"a":1,}',
  '{"a":[1,]}',
  "{a:1}",
  "{'a':1}",
  '{"a":01}',
  '{"a":1.}',
  '{"a":.5}',
  '{"a":-}',
  '{"a":1e}',
  '{"a":+1}',
  '{"a":NaN}',
  '{"a":Infinity}',
  '{"a":tru}',
  '{"a":nul}',
  '{"a":"\\x"}',
  '{"a":"\\u12G4"}',
  '{"a":"line\nbreak"}',
  '{"a":1}}',
  '{"a":1} x',
  '{"a":[1}',
  '{"a":{1:2}}',
  "\ufeff{}",
  '{"a":1}/* comment */',
];

describe("checking a body's JSON as it arrives", () => {
  it.each(validObjects)("accepts what JSON.parse accepts as an object: %j", (text) => {
    expect(isObjectByJsonParse(text)).toBe(true);
    for (const chunkSize of [1, 3, 1024]) {
      expect(scan(text, chunkSize).kind).toBe("scanned");
    }
  });

  it.each(invalidBodies)(
    "refuses what JSON.parse refuses, or what is not an object: %j",
    (text) => {
      expect(isObjectByJsonParse(text)).toBe(false);
      for (const chunkSize of [1, 3, 1024]) {
        expect(scan(text, chunkSize).kind).toBe("invalid");
      }
    },
  );

  it("agrees with JSON.parse on many bodies broken at random", () => {
    const original = JSON.stringify({
      model: "a-model",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: 'Hi "there"\n' }] }],
      tools: [
        { name: "edit", input_schema: { type: "object", properties: { n: { type: "number" } } } },
      ],
      numbers: [0, -1.5, 2e10, 3.25e-3],
      flags: [true, false, null],
    });
    let seed = 1;
    const random = (below: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % below;
    };
    const characters = '{}[]":,.-+eE0123456789 \\tnfrua\n';
    for (let attempt = 0; attempt < 3000; attempt += 1) {
      const position = random(original.length);
      const replacement = characters[random(characters.length)] ?? "";
      const mutated =
        random(2) === 0
          ? original.slice(0, position) + replacement + original.slice(position + 1)
          : original.slice(0, position) + original.slice(position + 1);
      expect({ mutated, kind: scan(mutated, 1 + random(9)).kind }).toEqual({
        mutated,
        kind: isObjectByJsonParse(mutated) ? "scanned" : "invalid",
      });
    }
  });

  it("notes where each top-level member lies, at every depth of nesting below", () => {
    const text = ' { "model" : "m" , "nested":{"model":"other"}, "n": -12.5e3 ,"t":true} ';
    const outcome = scan(text, 2);

    expect(outcome.kind).toBe("scanned");
    const members = outcome.kind === "scanned" ? outcome.body.members : [];
    expect(
      members.map((member) => [
        text.slice(member.keyStart, member.keyEnd),
        text.slice(member.valueStart, member.valueEnd),
      ]),
    ).toEqual([
      ['"model"', '"m"'],
      ['"nested"', '{"model":"other"}'],
      ['"n"', "-12.5e3"],
      ['"t"', "true"],
    ]);
    expect(outcome.kind === "scanned" && text[outcome.body.closingBraceOffset]).toBe("}");
  });

  it("refuses nesting deeper than its limit, and too many or too long top-level members", () => {
    const deepest = requestBodyShapeLimits.maximumDepth;
    const nested = (depth: number) => `{"a":${"[".repeat(depth - 1)}${"]".repeat(depth - 1)}}`;

    expect(scan(nested(deepest)).kind).toBe("scanned");
    expect(scan(nested(deepest + 1))).toEqual({
      kind: "invalid",
      reason: "the body nests too deeply",
    });
    const members = (count: number) =>
      `{${Array.from({ length: count }, (_, index) => `"k${index}":0`).join(",")}}`;
    expect(scan(members(requestBodyShapeLimits.maximumTopLevelMembers)).kind).toBe("scanned");
    expect(scan(members(requestBodyShapeLimits.maximumTopLevelMembers + 1)).kind).toBe("invalid");
    expect(scan(`{"${"k".repeat(257)}":0}`).kind).toBe("invalid");
  });

  it("measures the whitespace between tokens, which no provider counts", () => {
    const outcome = scan(`{"model" : "a b c" ,\n "x":[1, 2]${" ".repeat(1000)}}`);

    expect(outcome.kind === "scanned" && outcome.body.insignificantBytes).toBe(1006);
  });
});

/**
 * Base64 image data is left out of an estimate's text only where each
 * format sends an image, since a provider counts an image by its pixels;
 * the same bytes anywhere else are text the model reads, and count as such.
 */
describe("finding the images a body sends", () => {
  const picture = "iVBORw0KGgo".repeat(100);
  const dataUrl = `data:image/png;base64,${picture}`;
  const anthropicImage = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: picture },
  };

  function imagesIn(format: ProviderApiFormat, body: object) {
    const outcome = scan(JSON.stringify(body), 13, format);
    if (outcome.kind !== "scanned") {
      throw new Error(JSON.stringify(outcome));
    }
    const { imageCount, base64ImageBytes } = outcome.body;
    return { imageCount, base64ImageBytes };
  }

  it("finds Anthropic's base64 images in a message's parts and in a tool result's", () => {
    const body = {
      model: "m",
      messages: [
        { role: "user", content: [anthropicImage, { type: "text", text: "Look" }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: [anthropicImage] }],
        },
      ],
    };

    expect(imagesIn("anthropic_messages", body)).toEqual({
      imageCount: 2,
      base64ImageBytes: 2 * picture.length,
    });
  });

  it("finds the Responses API's images in a message's parts and in a tool's output", () => {
    const image = { type: "input_image", detail: "auto", image_url: dataUrl };
    const body = {
      model: "m",
      input: [
        { role: "user", content: [image] },
        { type: "function_call_output", call_id: "c", output: [image] },
      ],
    };

    expect(imagesIn("openai_responses", body)).toEqual({
      imageCount: 2,
      base64ImageBytes: 2 * dataUrl.length,
    });
  });

  it("finds Chat Completions' images in a message's parts", () => {
    const body = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] }],
    };

    expect(imagesIn("openai_chat_completions", body)).toMatchObject({
      imageCount: 1,
      base64ImageBytes: dataUrl.length,
    });
  });

  it.each([
    ["text that starts like a data URL", { type: "text", text: dataUrl }],
    ["an image part whose source is not base64", { type: "image", source: { data: picture } }],
    [
      "base64 data under a part that is not an image",
      { type: "text", source: anthropicImage.source },
    ],
  ])("counts as text, in Anthropic's format, %s", (_description, part) => {
    const body = { model: "m", messages: [{ role: "user", content: [part] }] };

    expect(imagesIn("anthropic_messages", body).base64ImageBytes).toBe(0);
  });

  it("counts as text an image part that gives its type twice", () => {
    const part = `{"type":"image","source":{"type":"base64","data":"${picture}"},"type":"text"}`;
    const outcome = scan(`{"model":"m","messages":[{"role":"user","content":[${part}]}]}`);

    expect(outcome.kind === "scanned" && outcome.body.base64ImageBytes).toBe(0);
  });

  it("counts as text an image's shape anywhere but a message's parts, such as in a tool's schema", () => {
    const body = {
      model: "m",
      tools: [
        {
          name: "t",
          input_schema: {
            type: "object",
            media_type: "image/png",
            data: picture,
            default: anthropicImage,
          },
        },
      ],
      system: [anthropicImage],
      messages: [{ role: "user", content: "Hi", extra: [anthropicImage] }],
    };

    expect(imagesIn("anthropic_messages", body).base64ImageBytes).toBe(0);
  });

  it("counts as text another format's image in the format the body is sent in", () => {
    const body = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "input_image", image_url: dataUrl }] }],
    };

    expect(imagesIn("openai_chat_completions", body).base64ImageBytes).toBe(0);
    expect(imagesIn("anthropic_messages", body).base64ImageBytes).toBe(0);
  });
});

/**
 * With the shape of the agent's requests, the scanner refuses as soon as
 * it reads it anything the agent never sends: a top-level member, or an
 * object of a type it never gives one in that place. Names are compared as
 * written, so a spelling a decoder would read as another name is refused.
 */
describe("refusing what the agent never sends", () => {
  const anthropicBody = (part: object) =>
    JSON.stringify({ model: "m", max_tokens: 8, messages: [{ role: "user", content: [part] }] });

  function outcomeOf(format: ProviderApiFormat, providerId: string, body: string) {
    const outcomes = [1, 5, body.length].map((chunkSize) =>
      scan(body, chunkSize, format, providerId),
    );
    // However the body is cut, the outcome is the same.
    expect(new Set(outcomes.map((outcome) => JSON.stringify(outcome))).size).toBe(1);
    const [outcome] = outcomes;
    return outcome?.kind === "not_relayed" ? outcome.what : outcome?.kind;
  }

  it.each([
    [
      "anthropic_messages",
      "anthropic",
      '{"model":"m","messages":[],"thread":{"type":"continue"}}',
      "the member `thread`",
    ],
    [
      "anthropic_messages",
      "anthropic",
      '{"model":"m","messages":[],"compaction":{}}',
      "the member `compaction`",
    ],
    [
      "anthropic_messages",
      "anthropic",
      '{"model":"m","container":{"id":"c"},"messages":[]}',
      "the member `container`",
    ],
    [
      "anthropic_messages",
      "anthropic",
      '{"model":"m","mcp_servers":[],"messages":[]}',
      "the member `mcp_servers`",
    ],
    [
      "openai_responses",
      "openai",
      '{"model":"m","previous_response_id":"r","input":[]}',
      "the member `previous_response_id`",
    ],
    [
      "openai_responses",
      "openai",
      '{"model":"m","background":true,"input":[]}',
      "the member `background`",
    ],
    [
      "openai_responses",
      "openai",
      '{"model":"m","service_tier":"priority","input":[]}',
      "the member `service_tier`",
    ],
    [
      "openai_chat_completions",
      "together",
      '{"model":"m","n":128,"messages":[]}',
      "the member `n`",
    ],
    [
      "openai_chat_completions",
      "openrouter",
      '{"model":"m","plugins":[],"messages":[]}',
      "the member `plugins`",
    ],
    [
      "openai_chat_completions",
      "openrouter",
      '{"model":"m","provider":{},"messages":[]}',
      "the member `provider`",
    ],
    [
      "openai_chat_completions",
      "deepseek",
      '{"model":"m","deferred":true,"messages":[]}',
      "the member `deferred`",
    ],
  ] as const)(
    "refuses, in %s to %s, a top-level member the agent never sends: %s",
    (format, providerId, body, what) => {
      expect(outcomeOf(format, providerId, body)).toBe(what);
    },
  );

  it.each([
    [
      { type: "document", source: { type: "url", url: "https://a/b.pdf" } },
      "the content part type `document`",
    ],
    [{ type: "container_upload", file_id: "f" }, "the content part type `container_upload`"],
    [
      { type: "image", source: { type: "url", url: "https://a/b.png" } },
      "the image source type `url`",
    ],
    [{ type: "image", source: { type: "file", file_id: "f" } }, "the image source type `file`"],
    [{ text: "a part without a type" }, "a content part without a `type`"],
    [{ type: 7 }, "a content part whose `type` is not text"],
    [
      { type: "text", text: "Hi", cache_control: { type: "persistent" } },
      "the cache marker type `persistent`",
    ],
  ])("refuses, in Anthropic's format, %j", (part, what) => {
    expect(outcomeOf("anthropic_messages", "anthropic", anthropicBody(part))).toBe(what);
  });

  it.each([
    [{ type: "advisor_20260301", name: "advisor" }, "the tool type `advisor_20260301`"],
    [{ type: "web_search_20250305", name: "web_search" }, "the tool type `web_search_20250305`"],
    [
      { type: "code_execution_20250825", name: "code_execution" },
      "the tool type `code_execution_20250825`",
    ],
  ])("refuses, in Anthropic's format, a tool the provider runs: %j", (tool, what) => {
    const body = JSON.stringify({ model: "m", messages: [], tools: [tool] });

    expect(outcomeOf("anthropic_messages", "anthropic", body)).toBe(what);
  });

  it("refuses a provider's tool declared mid-conversation, in an Anthropic tool change or a Responses item", () => {
    const toolChange = {
      type: "tool_addition",
      tool: { type: "tool_definition", definition: { type: "web_search_20250305", name: "w" } },
    };
    const additionalTools = {
      type: "additional_tools",
      role: "developer",
      tools: [{ type: "code_interpreter", container: { type: "auto", file_ids: ["f"] } }],
    };

    expect(
      outcomeOf(
        "anthropic_messages",
        "anthropic",
        JSON.stringify({ model: "m", messages: [{ role: "system", content: [toolChange] }] }),
      ),
    ).toBe("the tool type `web_search_20250305`");
    expect(
      outcomeOf(
        "openai_responses",
        "openai",
        JSON.stringify({ model: "m", input: [additionalTools] }),
      ),
    ).toBe("the tool type `code_interpreter`");
  });

  it.each([
    [
      "openai_responses",
      "openai",
      { model: "m", input: [{ type: "item_reference", id: "r" }] },
      "the conversation item type `item_reference`",
    ],
    [
      "openai_responses",
      "openai",
      { model: "m", input: [{ role: "user", content: [{ type: "input_file", file_id: "f" }] }] },
      "the content part type `input_file`",
    ],
    [
      "openai_responses",
      "openai",
      { model: "m", input: [], tools: [{ type: "mcp", server_url: "https://a" }] },
      "the tool type `mcp`",
    ],
    [
      "openai_chat_completions",
      "together",
      {
        model: "m",
        messages: [
          { role: "user", content: [{ type: "video_url", video_url: { url: "https://a/b.mp4" } }] },
        ],
      },
      "the content part type `video_url`",
    ],
    [
      "openai_chat_completions",
      "groq",
      {
        model: "m",
        messages: [{ role: "user", content: [{ type: "file", file: { file_id: "f" } }] }],
      },
      "the content part type `file`",
    ],
  ] as const)("refuses, in %s to %s, %j", (format, providerId, body, what) => {
    expect(outcomeOf(format, providerId, JSON.stringify(body))).toBe(what);
  });

  it.each([
    [
      "a type written with an escape",
      '{"type":"docum\\u0065nt","source":{"type":"url","url":"u"}}',
      "the content part type that is not a plain name",
    ],
    [
      "the key `type` written with an escape",
      '{"t\\u0079pe":"document"}',
      "a member whose name is written with an escape or outside ASCII",
    ],
    [
      "the key `type` in capitals",
      '{"type":"text","Type":"document"}',
      "the member `Type`, in that case",
    ],
    [
      "a key that folds to `source`, with a long s",
      '{"type":"image","\u017fource":{"type":"url"}}',
      "a member whose name is written with an escape or outside ASCII",
    ],
    ["a type in another case", '{"type":"Text","text":"Hi"}', "the content part type `Text`"],
  ])(
    "refuses %s, which a decoder would read otherwise than written",
    (_description, part, what) => {
      const body = `{"model":"m","messages":[{"role":"user","content":[${part}]}]}`;

      expect(outcomeOf("anthropic_messages", "anthropic", body)).toBe(what);
    },
  );

  it("refuses a top-level member written with an escape, or in another case", () => {
    expect(outcomeOf("openai_responses", "openai", '{"mod\\u0065l":"m","input":[]}')).toBe(
      "a member whose name is written with an escape or outside ASCII",
    );
    expect(outcomeOf("openai_responses", "openai", '{"model":"m","INPUT":[]}')).toBe(
      "the member `INPUT`, in that case",
    );
    expect(outcomeOf("openai_responses", "openai", '{"model":"m","Stream":true}')).toBe(
      "the member `Stream`",
    );
  });

  it("polices nothing in a tool's schema, a tool call's arguments or a message's text", () => {
    const body = JSON.stringify({
      model: "m",
      max_tokens: 8,
      messages: [
        { role: "user", content: "Please send a document." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t",
              name: "x",
              input: { type: "document", "T\u0079pe": 1, ſ: 2 },
            },
          ],
        },
      ],
      tools: [
        {
          name: "x",
          description: "Sends a document.",
          input_schema: {
            type: "object",
            properties: { type: { type: "string", enum: ["document"] } },
          },
        },
      ],
    });

    expect(outcomeOf("anthropic_messages", "anthropic", body)).toBe("scanned");
  });

  it("classes no object under a Responses API part as an image source, whatever its key", () => {
    const part = { type: "input_text", text: "Hi", extra: { anything: true } };
    const body = JSON.stringify({ model: "m", input: [{ role: "user", content: [part] }] });

    expect(outcomeOf("openai_responses", "openai", body)).toBe("scanned");
  });
});
