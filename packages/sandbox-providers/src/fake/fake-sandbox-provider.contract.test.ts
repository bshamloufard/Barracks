import { describeSandboxProviderContract } from "../test-support/sandbox-provider-contract.js";
import { FakeSandboxProvider } from "./fake-sandbox-provider.js";

describeSandboxProviderContract({
  providerName: "fake",
  unavailableReason: undefined,
  async setUp() {
    const launchCounts = new Map<string, number>();
    const provider = new FakeSandboxProvider({
      supervisorLauncher: ({ threadId }) => {
        launchCounts.set(threadId, (launchCounts.get(threadId) ?? 0) + 1);
        return undefined;
      },
    });
    const filesOf = (sandboxId: string): Map<string, string> => {
      const files = provider.filesOf(sandboxId);
      if (files === undefined) {
        throw new Error(`Sandbox ${sandboxId} does not exist.`);
      }
      return files;
    };
    return {
      provider,
      unknownSandboxId: "fake-sandbox-that-was-never-created",
      supervisorEnvironmentFor: (threadId) => ({ BARRACK_THREAD_ID: threadId }),
      reopenProvider: () => provider.reopen(),
      async waitForSupervisorLaunches(threadId, launchCount) {
        if ((launchCounts.get(threadId) ?? 0) < launchCount) {
          throw new Error(`The supervisor of ${threadId} was not launched ${launchCount} times.`);
        }
      },
      async writeFile(sandboxId, path, content) {
        filesOf(sandboxId).set(path, content);
      },
      async readFile(sandboxId, path) {
        return filesOf(sandboxId).get(path) ?? "";
      },
      async dispose() {},
    };
  },
});
