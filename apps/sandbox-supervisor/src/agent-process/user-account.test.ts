import { describe, expect, it } from "vitest";
import { lookUpUserAccount, parsePasswordEntry } from "./user-account.js";

describe("parsePasswordEntry", () => {
  it("reads the name, IDs, home directory and login shell", () => {
    expect(
      parsePasswordEntry("barrack-agent:x:10002:10002::/home/barrack-agent:/bin/bash\n"),
    ).toEqual({
      name: "barrack-agent",
      userId: 10002,
      groupId: 10002,
      homeDirectory: "/home/barrack-agent",
      loginShell: "/bin/bash",
    });
  });

  it("refuses a line that is not a password entry", () => {
    expect(parsePasswordEntry("barrack-agent:x:not-a-number:10002::/home:/bin/sh")).toBeUndefined();
    expect(parsePasswordEntry("too:few:fields")).toBeUndefined();
  });
});

describe.runIf(process.platform === "linux")("lookUpUserAccount", () => {
  it("finds a user that exists", async () => {
    expect(await lookUpUserAccount("root")).toMatchObject({
      found: true,
      account: { name: "root", userId: 0, groupId: 0 },
    });
  });

  it("says when no such user exists", async () => {
    expect(await lookUpUserAccount("barrack-no-such-user")).toEqual({
      found: false,
      reason: 'no user named "barrack-no-such-user" exists',
    });
  });
});
