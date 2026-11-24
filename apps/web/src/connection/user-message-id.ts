/**
 * Mints the identifier of a message the user has just composed: 128 random
 * bits as hexadecimal, which the protocol's `userMessageIdSchema` accepts.
 * `crypto.getRandomValues` is used rather than `crypto.randomUUID`, which
 * browsers offer only on HTTPS and localhost, so the page also works when a
 * development control plane is opened by its address on a local network.
 */
export function mintUserMessageId(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
