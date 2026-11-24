import { describeSandboxProviderContract } from "../test-support/sandbox-provider-contract.js";
import { type FakeSandboxLaunch, FakeSandboxProvider } from "./fake-sandbox-provider.js";

describeSandboxProviderContract({
  providerName: "fake",
  unavailableReason: undefined,
  async setUp() {
    const launchCounts = new Map<string, number>();
    const latestLaunches = new Map<string, FakeSandboxLaunch>();
    const provider = new FakeSandboxProvider({
      supervisorLauncher: (launch) => {
        launchCounts.set(launch.threadId, (launchCounts.get(launch.threadId) ?? 0) + 1);
        latestLaunches.set(launch.sandboxId, launch);
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
    const launchOf = (sandboxId: string): FakeSandboxLaunch => {
      const launch = latestLaunches.get(sandboxId);
      if (launch === undefined) {
        throw new Error(`Sandbox ${sandboxId} was never launched.`);
      }
      return launch;
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
      async readSecretAsSupervisor(sandboxId, secretName) {
        return launchOf(sandboxId).supervisorSecrets[secretName] ?? "";
      },
      async describeSandboxAsProviderReportsIt(sandboxId) {
        const { threadId, supervisorEnvironment } = launchOf(sandboxId);
        const status = await provider.getStatus(sandboxId);
        return JSON.stringify({ threadId, supervisorEnvironment, status });
      },
      agentCommands: { unavailableBecause: "a fake sandbox runs no processes" },
      async dispose() {},
    };
  },
});
