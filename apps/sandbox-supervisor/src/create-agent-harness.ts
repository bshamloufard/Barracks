import type { AgentHarness, AgentHarnessObserver } from "./agent-harness.js";
import type { AgentHarnessConfiguration } from "./configuration.js";
import { FakeAgentHarness } from "./fake-agent/fake-agent-harness.js";
import type { Logger } from "./logger.js";
import { PiAgentHarness } from "./pi/pi-agent-harness.js";

export type AgentHarnessContext = {
  threadId: string;
  sourceEnvironment: NodeJS.ProcessEnv;
  logger: Logger;
};

export function createAgentHarness(
  configuration: AgentHarnessConfiguration,
  observer: AgentHarnessObserver,
  context: AgentHarnessContext,
): AgentHarness {
  if (configuration.kind === "fake") {
    return new FakeAgentHarness(observer);
  }
  return new PiAgentHarness(observer, {
    threadId: context.threadId,
    model: configuration.model,
    workspaceDirectory: configuration.workspaceDirectory,
    stateDirectory: configuration.stateDirectory,
    sourceEnvironment: context.sourceEnvironment,
    logger: context.logger,
  });
}
