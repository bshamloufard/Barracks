import { describe, expect, it } from "vitest";
import { JsonBodyScanner, type JsonScanOutcome } from "./json-body-scanner.js";
import { requestBodyShapeLimits } from "./request-body.js";

/** Scans `text` split into chunks of `chunkSize` bytes, as a body arriving in pieces would be. */
function scan(text: string | Buffer, chunkSize = 7): JsonScanOutcome {
  const bytes = typeof text === "string" ? Buffer.from(text) : text;
  const scanner = new JsonBodyScanner(requestBodyShapeLimits);
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

  it("finds the images each format sends, and the bytes of their base64 data", () => {
    const picture = "iVBORw0KGgo".repeat(100);
    const body = {
      model: "m",
      messages: [
        {
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: picture } },
            { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: picture },
            },
          ],
        },
        { content: [{ type: "input_image", image_url: `data:image/png;base64,${picture}` }] },
        {
          content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${picture}` } }],
        },
        { content: [{ type: "text", text: `data:image/png;base64,${picture}!` }] },
      ],
    };
    const outcome = scan(JSON.stringify(body), 13);

    expect(outcome.kind).toBe("scanned");
    if (outcome.kind === "scanned") {
      expect(outcome.body.imageCount).toBe(4);
      expect(outcome.body.base64ImageBytes).toBe(
        3 * picture.length + "data:image/png;base64,".length + "data:image/jpeg;base64,".length,
      );
    }
  });
});
