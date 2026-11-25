/** An answer longer than its reader allows; none of OpenAI's documented ones comes near. */
export class ResponseTooLargeError extends Error {
  constructor(maximumBytes: number) {
    super(`The answer is longer than the ${maximumBytes} bytes allowed for it.`);
    this.name = "ResponseTooLargeError";
  }
}

/**
 * A response's JSON body, read only up to `maximumBytes`, so an answer
 * from OpenAI (or anything answering at its address) cannot make the
 * control plane hold more than that. Throws `ResponseTooLargeError` past
 * it, and as `JSON.parse` does for a body that is not JSON.
 */
export async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (Number(response.headers.get("content-length") ?? 0) > maximumBytes) {
    await response.body?.cancel();
    throw new ResponseTooLargeError(maximumBytes);
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body?.getReader();
  while (reader !== undefined) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(maximumBytes);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
