import { z } from "zod";
import { maximumFrameLength } from "./limits.js";
import type { ParseResult } from "./parse-result.js";

/**
 * Decodes the text of one WebSocket frame and checks it against a message
 * schema. The length check comes first so an oversized frame is refused
 * before any time is spent decoding it.
 */
export function parseFrame<Message>(
  schema: z.ZodType<Message>,
  frameText: string,
): ParseResult<Message> {
  if (frameText.length > maximumFrameLength) {
    return {
      ok: false,
      errorMessage: `Frame is ${frameText.length} characters long; the limit is ${maximumFrameLength}.`,
    };
  }
  const decoded = decodeJson(frameText);
  if (!decoded.ok) {
    return decoded;
  }
  const validation = schema.safeParse(decoded.value);
  if (!validation.success) {
    return { ok: false, errorMessage: z.prettifyError(validation.error) };
  }
  return { ok: true, value: validation.data };
}

function decodeJson(frameText: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(frameText) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, errorMessage: `Frame is not valid JSON: ${reason}` };
  }
}
