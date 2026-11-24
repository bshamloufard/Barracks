import { describe, expect, it } from "vitest";
import { branchNameSchema, workBranchFor } from "./repositories.js";
import { parseControlPlaneToSupervisorMessage } from "./supervisor-messages.js";
import { createThreadRequestSchema } from "./threads-api.js";
import {
  buildPublicationBundleUploadPath,
  parsePublicationBundleUploadPath,
} from "./workspace-messages.js";

describe("branch names", () => {
  it.each(["main", "release/2.0", "feature/add-login", "v1.2_fix"])("accepts %s", (name) => {
    expect(branchNameSchema.safeParse(name).success).toBe(true);
  });

  it.each([
    "-delete",
    "../main",
    "a..b",
    "main/",
    "main.",
    ".hidden",
    "feature/.hidden",
    "a//b",
    "main.lock",
    "HEAD@{1}",
    "main~1",
    "has space",
    "",
  ])("refuses %j, which Git could read as something other than a branch", (name) => {
    expect(branchNameSchema.safeParse(name).success).toBe(false);
  });

  it("names a thread's work branch after the thread, as a valid branch name", () => {
    expect(workBranchFor("0b6f-thread_1")).toBe("barrack/0b6f-thread_1");
    expect(branchNameSchema.safeParse(workBranchFor("0b6f-thread_1")).success).toBe(true);
  });
});

describe("creating a thread", () => {
  it("takes no repository, or one with its access and an optional base branch", () => {
    expect(createThreadRequestSchema.safeParse({}).success).toBe(true);
    expect(
      createThreadRequestSchema.safeParse({
        repository: { url: "https://github.com/octo/app", access: "none" },
      }).success,
    ).toBe(true);
    expect(
      createThreadRequestSchema.safeParse({
        repository: { url: "https://github.com/octo/app", access: "ssh_key" },
      }).success,
    ).toBe(false);
  });
});

describe("workspace messages", () => {
  it("never carry a credential and a refusal at once", () => {
    const frame = JSON.stringify({
      type: "repository_credential",
      requestId: "request-1",
      outcome: { isGranted: false, reason: "No", password: "secret" },
    });

    expect(parseControlPlaneToSupervisorMessage(frame).ok).toBe(false);
  });

  it("refuse a commit author whose name could forge another header line", () => {
    const frame = JSON.stringify({
      type: "prepare_workspace",
      agentHasWorkedBefore: false,
      repository: {
        url: "https://github.com/octo/app",
        access: "none",
        baseBranch: null,
        workBranch: "barrack/thread-1",
        commitAuthor: { name: "Ann\ncommitter Eve", email: "ann@example.com" },
      },
    });

    expect(parseControlPlaneToSupervisorMessage(frame).ok).toBe(false);
  });

  it("address a publication bundle's upload by thread and publication, and read it back", () => {
    const path = buildPublicationBundleUploadPath("thread-1", "publication-1");

    expect(path).toBe("/threads/thread-1/supervisor/publication-bundles/publication-1");
    expect(parsePublicationBundleUploadPath(path)).toEqual({
      ok: true,
      value: { threadId: "thread-1", publicationId: "publication-1" },
    });
    expect(
      parsePublicationBundleUploadPath("/threads/../supervisor/publication-bundles/x").ok,
    ).toBe(false);
  });
});
