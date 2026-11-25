import type { SupportedStorage } from "@supabase/supabase-js";

type BackingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Where supabase-js keeps the session and the PKCE code verifiers of the
 * emails this browser asked for: the browser's local storage, or memory
 * outside a browser (the tests), as supabase-js would choose itself. It can
 * also put back what one call changed.
 *
 * That is for a refused email. Asking for one stores a new verifier before
 * Supabase answers, and when Supabase refuses, supabase-js deletes it again
 * (`signInWithOtp` and `removePKCEVerifier` in auth-js 2.119.2), which also
 * deletes the one an email already in the user's inbox needs (the copy a
 * link without a flow identifier is exchanged with). So a refused request,
 * typically because the project may send no more emails for now, would
 * break the very link the user is then told to use. Putting storage back as
 * it was keeps that link working.
 */
export class RevertibleStorage implements SupportedStorage {
  readonly #backing: BackingStorage;
  /** What each item held before the change being watched, while one is. */
  #itemsBefore: Map<string, string | null> | undefined;

  constructor(backing: BackingStorage = browserStorageOrMemory()) {
    this.#backing = backing;
  }

  getItem(key: string): string | null {
    return this.#backing.getItem(key);
  }

  setItem(key: string, value: string): void {
    this.#rememberBefore(key);
    this.#backing.setItem(key, value);
  }

  removeItem(key: string): void {
    this.#rememberBefore(key);
    this.#backing.removeItem(key);
  }

  /** Runs `change`, then puts back every item it set or removed unless `isKept(outcome)`. */
  async revertUnless<Outcome>(
    change: () => Promise<Outcome>,
    isKept: (outcome: Outcome) => boolean,
  ): Promise<Outcome> {
    this.#itemsBefore = new Map();
    try {
      const outcome = await change();
      if (!isKept(outcome)) {
        this.#putBack();
      }
      return outcome;
    } catch (error) {
      this.#putBack();
      throw error;
    } finally {
      this.#itemsBefore = undefined;
    }
  }

  #rememberBefore(key: string): void {
    if (this.#itemsBefore !== undefined && !this.#itemsBefore.has(key)) {
      this.#itemsBefore.set(key, this.#backing.getItem(key));
    }
  }

  #putBack(): void {
    for (const [key, value] of this.#itemsBefore ?? []) {
      if (value === null) {
        this.#backing.removeItem(key);
      } else {
        this.#backing.setItem(key, value);
      }
    }
  }
}

/** A browser that blocks storage throws on reading `localStorage`, as supabase-js's own check allows for. */
function browserStorageOrMemory(): BackingStorage {
  try {
    if (typeof window !== "undefined" && window.localStorage !== undefined) {
      return window.localStorage;
    }
  } catch {
    // Kept in memory instead, for as long as the page is open.
  }
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}
