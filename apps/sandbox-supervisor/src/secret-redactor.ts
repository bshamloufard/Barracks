/**
 * The model credentials this supervisor has been given, so that none of
 * them is ever written to its log or sent as an event, even by accident:
 * a provider that echoes a key in its error, a tool that prints a file
 * holding one. Every key ever received in this process is kept, so one the
 * user has since replaced is still recognised.
 *
 * This is a safety net, not a boundary: the agent itself can read its key
 * and could send it anywhere, encoded or split, and nothing here would
 * notice. What it stops is the plain key turning up where it should not.
 */
export class SecretRedactor {
  readonly #secrets = new Set<string>();

  static readonly replacement = "[redacted model credential]";

  remember(secret: string): void {
    this.#secrets.add(secret);
  }

  redactText(text: string): string {
    let redacted = text;
    for (const secret of this.#secrets) {
      redacted = redacted.replaceAll(secret, SecretRedactor.replacement);
    }
    return redacted;
  }

  /** A copy of a JSON value with every known secret in its strings replaced. */
  redactValue<Value>(value: Value): Value {
    if (this.#secrets.size === 0) {
      return value;
    }
    return this.#redactJson(value) as Value;
  }

  #redactJson(value: unknown): unknown {
    if (typeof value === "string") {
      return this.redactText(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.#redactJson(item));
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.#redactJson(item)]),
      );
    }
    return value;
  }
}
