import type { ProviderApiFormat } from "@barrack/model-catalogue";
import { describe, expect, it } from "vitest";
import { JsonBodyScanner, type JsonScanOutcome } from "./json-body-scanner.js";
import { requestBodyShapeLimits } from "./request-body.js";

/** Scans `text` split into chunks of `chunkSize` bytes, as a body arriving in pieces would be. */
function scan(
  text: string | Buffer,
  chunkSize = 7,
  format: ProviderApiFormat = "anthropic_messages",
): JsonScanOutcome {
  const bytes = typeof text === "string" ? Buffer.from(text) : text;
  const scanner = new JsonBodyScanner(requestBodyShapeLimits, format);
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
      throw new Error(outcome.reason);
    }
    const { imageCount, base64ImageBytes, referencedInputType } = outcome.body;
    return { imageCount, base64ImageBytes, referencedInputType };
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
      referencedInputType: undefined,
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
      referencedInputType: undefined,
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

  it.each([
    ["anthropic_messages", { type: "document", source: { type: "url", url: "https://a/b.pdf" } }],
    ["anthropic_messages", { type: "container_upload", file_id: "file_1" }],
    ["openai_responses", { type: "input_file", file_id: "file-1" }],
    ["openai_chat_completions", { type: "file", file: { file_id: "file-1" } }],
  ] as const)("notes, in %s, a part that refers to a file or document: %j", (format, part) => {
    const conversation = format === "openai_responses" ? "input" : "messages";
    const body = { model: "m", [conversation]: [{ role: "user", content: [part] }] };

    expect(imagesIn(format, body).referencedInputType).toBe(part.type);
  });

  it("notes a stored item, a remote MCP server or file search among the Responses API's input and tools", () => {
    expect(
      imagesIn("openai_responses", { model: "m", input: [{ type: "item_reference", id: "msg_1" }] })
        .referencedInputType,
    ).toBe("item_reference");
    expect(
      imagesIn("openai_responses", { model: "m", input: "Hi", tools: [{ type: "mcp" }] })
        .referencedInputType,
    ).toBe("mcp");
    expect(
      imagesIn("openai_responses", { model: "m", input: "Hi", tools: [{ type: "file_search" }] })
        .referencedInputType,
    ).toBe("file_search");
    // Tools can also be declared mid-conversation, as the pinned agent does with function tools.
    expect(
      imagesIn("openai_responses", {
        model: "m",
        input: [{ type: "additional_tools", role: "developer", tools: [{ type: "mcp" }] }],
      }).referencedInputType,
    ).toBe("mcp");
  });

  it("notes nothing for the same words elsewhere, such as an argument the agent passed a tool", () => {
    const body = {
      model: "m",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t", name: "x", input: { type: "file" } }],
        },
      ],
      tools: [
        { name: "x", input_schema: { type: "object", properties: { type: { type: "string" } } } },
      ],
    };

    expect(imagesIn("anthropic_messages", body).referencedInputType).toBeUndefined();
  });
});
