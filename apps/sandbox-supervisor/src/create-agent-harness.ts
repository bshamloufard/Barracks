import type { AgentDesktop, AgentHarness, AgentHarnessObserver } from "./agent-harness.js";
import type { AgentProcessLauncher } from "./agent-process/agent-process-launcher.js";
import type { AgentHarnessConfiguration } from "./configuration.js";
import { FakeAgentHarness } from "./fake-agent/fake-agent-harness.js";
import type { Logger } from "./logger.js";
import { PiAgentHarness } from "./pi/pi-agent-harness.js";

export type AgentHarnessContext = {
  threadId: string;
  sourceEnvironment: NodeJS.ProcessEnv;
  agentProcessLauncher: AgentProcessLauncher;
  /** Undefined for a sandbox without a desktop, whose agent gets no computer tool. */
  desktop: AgentDesktop | undefined;
  logger: Logger;
};

export function createAgentHarness(
  configuration: AgentHarnessConfiguration,
  observer: AgentHarnessObserver,
  context: AgentHarnessContext,
): AgentHarness {
  if (configuration.kind === "fake") {
    return new FakeAgentHarness(observer, { desktop: context.desktop });
  }
  return new PiAgentHarness(observer, {
    threadId: context.threadId,
    workspaceDirectory: configuration.workspaceDirectory,
    stateDirectory: configuration.stateDirectory,
    sourceEnvironment: context.sourceEnvironment,
    agentProcessLauncher: context.agentProcessLauncher,
    desktop: context.desktop?.configuration,
    logger: context.logger,
  });
}
