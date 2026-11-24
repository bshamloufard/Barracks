import { rename, writeFile } from "node:fs/promises";
import type { DesktopControlHolder } from "@barrack/protocol";

/**
 * Who holds the desktop's mouse and keyboard, as the control plane last
 * said, written where the agent's computer tool reads it before every
 * input. The supervisor writes it as its own user into a directory the
 * agent may read but not write (the sandbox image's `/run/barrack-desktop`),
 * so the agent cannot claim control back while the user drives. It is
 * written whole and renamed into place, so a reader never sees half a word.
 *
 * Every supervisor starts with the agent in control: a file left by an
 * earlier one says nothing about now, and the control plane says who holds
 * it after every welcome.
 */
export class DesktopControlFile {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async write(holder: DesktopControlHolder): Promise<void> {
    const temporaryPath = `${this.#filePath}.next`;
    await writeFile(temporaryPath, `${holder}\n`, { mode: 0o644 });
    await rename(temporaryPath, this.#filePath);
  }
}

/** What the agent's computer tool reads: anything but "user" leaves the agent in control. */
export function parseDesktopControlFile(contents: string): DesktopControlHolder {
  return contents.trim() === "user" ? "user" : "agent";
}
