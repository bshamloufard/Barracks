import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runCommand = promisify(execFile);

/** An operating-system user, as its password database entry describes it. */
export type UserAccount = {
  name: string;
  userId: number;
  groupId: number;
  homeDirectory: string;
  loginShell: string;
};

export type UserAccountLookup =
  | { found: true; account: UserAccount }
  | { found: false; reason: string };

/**
 * Looks a user up with `getent`, which reads the same databases the C
 * library does. Node has no binding for this; `os.userInfo()` describes only
 * the current user.
 */
export async function lookUpUserAccount(userName: string): Promise<UserAccountLookup> {
  let entry: string;
  try {
    ({ stdout: entry } = await runCommand("getent", ["passwd", userName], { env: {} }));
  } catch (error) {
    // getent exits with 2 when the database has no such entry.
    const reason =
      error instanceof Error && "code" in error && error.code === 2
        ? `no user named "${userName}" exists`
        : `the user "${userName}" could not be looked up: ${describeError(error)}`;
    return { found: false, reason };
  }
  const account = parsePasswordEntry(entry);
  return account === undefined
    ? { found: false, reason: `the entry for "${userName}" could not be read` }
    : { found: true, account };
}

/** Reads one `passwd(5)` line: `name:password:uid:gid:comment:home:shell`. */
export function parsePasswordEntry(entry: string): UserAccount | undefined {
  const fields = entry.trim().split(":");
  if (fields.length !== 7) {
    return undefined;
  }
  const [name, , userIdField, groupIdField, , homeDirectory, loginShell] = fields;
  const userId = Number(userIdField);
  const groupId = Number(groupIdField);
  if (
    name === undefined ||
    homeDirectory === undefined ||
    loginShell === undefined ||
    !Number.isInteger(userId) ||
    !Number.isInteger(groupId)
  ) {
    return undefined;
  }
  return { name, userId, groupId, homeDirectory, loginShell };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
