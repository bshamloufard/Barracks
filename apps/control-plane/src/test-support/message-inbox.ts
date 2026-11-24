const defaultWaitInMilliseconds = 2_000;

type Waiter<Message> = {
  check: (messages: readonly Message[]) => boolean;
  resolve: () => void;
};

/**
 * Collects the messages a test peer receives and lets a test wait until they
 * satisfy a condition, failing with everything received so far if they do
 * not within a short time.
 */
export class MessageInbox<Message> {
  readonly messages: Message[] = [];
  readonly #waiters = new Set<Waiter<Message>>();

  add(message: Message): void {
    this.messages.push(message);
    for (const waiter of this.#waiters) {
      if (waiter.check(this.messages)) {
        this.#waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  /** Resolves with the first received message that matches. */
  async waitFor(description: string, matches: (message: Message) => boolean): Promise<Message> {
    await this.waitUntil(description, (messages) => messages.some(matches));
    const match = this.messages.find(matches);
    if (match === undefined) {
      throw new Error(`Expected a message that is ${description}`);
    }
    return match;
  }

  waitUntil(description: string, check: (messages: readonly Message[]) => boolean): Promise<void> {
    if (check(this.messages)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        const received = JSON.stringify(this.messages, null, 2);
        reject(new Error(`Timed out waiting until ${description}. Received so far: ${received}`));
      }, defaultWaitInMilliseconds);
      const waiter: Waiter<Message> = {
        check,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      this.#waiters.add(waiter);
    });
  }
}
