import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSupervisorSecrets } from "./supervisor-secrets.js";

let parentDirectory: string;
let secretsDirectory: string;
const tokenFileName = "BARRACK_SUPERVISOR_TOKEN";

beforeEach(async () => {
  parentDirectory = await mkdtemp(path.join(tmpdir(), "barrack-supervisor-secrets-"));
  secretsDirectory = path.join(parentDirectory, "secrets");
  await mkdir(secretsDirectory, { mode: 0o700 });
});

afterEach(async () => {
  await rm(parentDirectory, { recursive: true, force: true });
});

async function writeToken(contents: string, mode = 0o400): Promise<string> {
  const tokenPath = path.join(secretsDirectory, tokenFileName);
  await writeFile(tokenPath, contents, { mode });
  await chmod(tokenPath, mode);
  return tokenPath;
}

describe("reading the supervisor's secrets", () => {
  it("reads the token from its file, exactly as written", async () => {
    await writeToken("a".repeat(64));

    expect(await readSupervisorSecrets(secretsDirectory)).toEqual({
      ok: true,
      secrets: { supervisorToken: "a".repeat(64) },
    });
  });

  it("refuses a token file other users could read, without echoing it", async () => {
    await writeToken("token-value", 0o644);

    const result = await readSupervisorSecrets(secretsDirectory);

    expect(result).toEqual({
      ok: false,
      problems: [expect.stringMatching(/is mode 0644, so other users can reach it/)],
    });
    expect(JSON.stringify(result)).not.toContain("token-value");
  });

  it("refuses a secrets directory other users may enter", async () => {
    await writeToken("token-value");
    await chmod(secretsDirectory, 0o755);

    expect(await readSupervisorSecrets(secretsDirectory)).toEqual({
      ok: false,
      problems: [expect.stringMatching(/^BARRACK_SUPERVISOR_SECRETS_DIRECTORY: .* is mode 0755/)],
    });
  });

  it("says the provider handed nothing over when the token is missing", async () => {
    expect(await readSupervisorSecrets(secretsDirectory)).toEqual({
      ok: false,
      problems: [expect.stringMatching(/does not exist: the sandbox provider did not hand/)],
    });
  });

  it("does not follow a link planted in place of the token", async () => {
    const elsewhere = path.join(parentDirectory, "elsewhere");
    await writeFile(elsewhere, "not the token", { mode: 0o400 });
    await symlink(elsewhere, path.join(secretsDirectory, tokenFileName));

    expect(await readSupervisorSecrets(secretsDirectory)).toMatchObject({ ok: false });
  });

  it("refuses an empty token", async () => {
    await writeToken("");

    expect(await readSupervisorSecrets(secretsDirectory)).toMatchObject({ ok: false });
  });
});
