import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * The keys model credentials are encrypted under, which the database never
 * holds: they come from the control plane's configuration
 * (`BARRACK_MODEL_CREDENTIAL_KEY`, and `BARRACK_MODEL_CREDENTIAL_PREVIOUS_KEYS`
 * while rotating), so a copy of the database, or a reader of it, learns no
 * key.
 *
 * Each credential is sealed with AES-256-GCM, which authenticates as well as
 * encrypts, under a fresh 96-bit nonce, and bound to its owner and provider
 * as associated data: a sealed credential copied into another user's row, or
 * another provider's, fails authentication instead of decrypting. Each
 * sealed credential names its key by fingerprint, so a key's replacement can
 * be rolled out with the old key still able to open what it sealed.
 */
export class CredentialKeyring {
  readonly #currentKey: KeyWithFingerprint;
  readonly #keysByFingerprint: ReadonlyMap<string, Buffer>;

  /** `current` seals everything new; `previous` keys only open what they sealed. */
  constructor(current: Buffer, previous: readonly Buffer[] = []) {
    this.#currentKey = withFingerprint(current);
    this.#keysByFingerprint = new Map(
      [this.#currentKey, ...previous.map(withFingerprint)].map((entry) => [
        entry.fingerprint,
        entry.key,
      ]),
    );
  }

  get currentFingerprint(): string {
    return this.#currentKey.fingerprint;
  }

  holdsKey(fingerprint: string): boolean {
    return this.#keysByFingerprint.has(fingerprint);
  }

  seal(plaintext: string, binding: CredentialBinding): SealedCredential {
    const nonce = randomBytes(nonceLengthInBytes);
    const cipher = createCipheriv(algorithm, this.#currentKey.key, nonce);
    cipher.setAAD(describeBinding(binding));
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      keyFingerprint: this.#currentKey.fingerprint,
      nonce,
      ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]),
    };
  }

  /** Throws `UnreadableCredentialError` for an unknown key, or a credential altered or moved. */
  open(sealed: SealedCredential, binding: CredentialBinding): string {
    const key = this.#keysByFingerprint.get(sealed.keyFingerprint);
    if (key === undefined) {
      throw new UnreadableCredentialError("unknown_key", binding);
    }
    if (sealed.ciphertext.length < authenticationTagLengthInBytes) {
      throw new UnreadableCredentialError("not_authentic", binding);
    }
    const tagStart = sealed.ciphertext.length - authenticationTagLengthInBytes;
    const decipher = createDecipheriv(algorithm, key, sealed.nonce);
    decipher.setAAD(describeBinding(binding));
    decipher.setAuthTag(sealed.ciphertext.subarray(tagStart));
    try {
      const decrypted = Buffer.concat([
        decipher.update(sealed.ciphertext.subarray(0, tagStart)),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    } catch {
      throw new UnreadableCredentialError("not_authentic", binding);
    }
  }
}

/** Whose credential, for which provider: what a sealed credential is bound to. */
export type CredentialBinding = { ownerUserId: string; providerId: string };

export type SealedCredential = {
  /** Which key sealed it; never the key. */
  keyFingerprint: string;
  nonce: Buffer;
  /** The encrypted credential followed by GCM's 16-byte authentication tag. */
  ciphertext: Buffer;
};

/**
 * - `unknown_key`: sealed under a key this control plane was not given.
 * - `not_authentic`: altered, or moved from another user's or provider's row.
 */
export class UnreadableCredentialError extends Error {
  constructor(
    readonly reason: "unknown_key" | "not_authentic",
    binding: CredentialBinding,
  ) {
    super(
      reason === "unknown_key"
        ? `The model credential of user "${binding.ownerUserId}" for "${binding.providerId}" was encrypted under a key this control plane does not have.`
        : `The model credential of user "${binding.ownerUserId}" for "${binding.providerId}" failed authentication: it was altered, or moved from another row.`,
    );
    this.name = "UnreadableCredentialError";
  }
}

/** 32 bytes, for AES-256. */
export const credentialKeyLengthInBytes = 32;

const algorithm = "aes-256-gcm";
/** GCM's standard nonce; random nonces of this length are safe for far more credentials than any installation holds. */
const nonceLengthInBytes = 12;
const authenticationTagLengthInBytes = 16;

/**
 * Reads a key as configured: base64 of exactly 32 random bytes, which
 * `openssl rand -base64 32` prints. Returns a problem for anything else.
 */
export function parseCredentialKey(text: string): { key: Buffer } | { problem: string } {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    return { problem: "must be base64, as `openssl rand -base64 32` prints it" };
  }
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== credentialKeyLengthInBytes) {
    return {
      problem: `must be ${credentialKeyLengthInBytes} bytes once decoded, as \`openssl rand -base64 32\` prints, not ${key.length}`,
    };
  }
  return { key };
}

type KeyWithFingerprint = { key: Buffer; fingerprint: string };

/**
 * A key's name in what it sealed: the start of an HMAC of a fixed label
 * under the key, which says nothing about the key itself.
 */
function withFingerprint(key: Buffer): KeyWithFingerprint {
  if (key.length !== credentialKeyLengthInBytes) {
    throw new Error(`A credential key must be ${credentialKeyLengthInBytes} bytes.`);
  }
  const fingerprint = createHmac("sha256", key)
    .update("barrack model credential key fingerprint")
    .digest("hex")
    .slice(0, 16);
  return { key, fingerprint };
}

/** Separated by a byte no identifier holds, so no two bindings read alike. */
function describeBinding(binding: CredentialBinding): Buffer {
  return Buffer.from(
    `barrack model credential v1\0${binding.ownerUserId}\0${binding.providerId}`,
    "utf8",
  );
}
