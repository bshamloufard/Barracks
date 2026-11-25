import { describe, expect, it } from "vitest";
import { ResponseTooLargeError, readBoundedJson } from "./read-bounded-json.js";

function streamedResponse(text: string, headers: Record<string, string> = {}): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let start = 0; start < bytes.length; start += 16) {
        controller.enqueue(bytes.slice(start, start + 16));
      }
      controller.close();
    },
  });
  return new Response(body, { headers });
}

describe("reading a bounded JSON answer", () => {
  it("reads an answer within the bound", async () => {
    expect(await readBoundedJson(streamedResponse('{"models":[]}'), 64)).toEqual({ models: [] });
  });

  it("refuses an answer that grows past the bound without saying its length", async () => {
    const long = JSON.stringify({ padding: "x".repeat(200) });

    await expect(readBoundedJson(streamedResponse(long), 64)).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it("refuses an answer whose declared length is past the bound before reading it", async () => {
    const response = streamedResponse("{}", { "content-length": "1000000" });

    await expect(readBoundedJson(response, 64)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});
