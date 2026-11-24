import { createHash, timingSafeEqual } from "node:crypto";
import type { UserStore } from "../users/user-store.js";
import type { UserAdmission } from "./user-admission.js";

/**
 * The email address is kept only as this digest (see `UserStore`), which is
 * enough to compare it with the addresses an installation lists.
 */
export function digestConfirmedEmailAddress(emailAddress: string): Buffer {
  return createHash("sha256").update(emailAddress).digest();
}

/**
 * Whether the installation still admits a thread's owner, asked when no
 * request of theirs is at hand: by the model proxy, before it spends their
 * key on their thread's behalf. An installation admitting everyone who can
 * sign in admits everyone recorded; one admitting listed addresses admits
 * a user whose last confirmed address, as recorded when they last signed
 * in, is listed now. One with no address recorded (not signed in since
 * the digest was first kept) is not admitted until they sign in again,
 * which records it.
 */
export class OwnerAdmission {
  readonly #admission: UserAdmission;
  readonly #userStore: UserStore;
  readonly #listedDigests: Buffer[];

  constructor(admission: UserAdmission, userStore: UserStore) {
    this.#admission = admission;
    this.#userStore = userStore;
    this.#listedDigests =
      admission.kind === "listed-email-addresses"
        ? [...admission.emailAddresses].map(digestConfirmedEmailAddress)
        : [];
  }

  async isStillAdmitted(userId: string): Promise<boolean> {
    if (this.#admission.kind === "anyone-who-can-sign-in") {
      return true;
    }
    const recorded = await this.#userStore.readConfirmedEmailDigest(userId);
    if (recorded === undefined) {
      return false;
    }
    return this.#listedDigests.some(
      (listed) => listed.length === recorded.length && timingSafeEqual(listed, recorded),
    );
  }
}
