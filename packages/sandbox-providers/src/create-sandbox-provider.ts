import { DaytonaSandboxProvider } from "./daytona/daytona-sandbox-provider.js";
import { createDaytonaSdkApi } from "./daytona/daytona-sdk-api.js";
import { DockerSandboxProvider } from "./docker/docker-sandbox-provider.js";
import { FakeSandboxProvider } from "./fake/fake-sandbox-provider.js";
import { LocalProcessSandboxProvider } from "./local-process/local-process-sandbox-provider.js";
import type { SandboxProviderConfiguration } from "./provider-configuration.js";
import type { SandboxProvider } from "./sandbox-provider.js";

/** The one place that knows which class implements which provider. */
export function createSandboxProvider(
  configuration: SandboxProviderConfiguration,
): SandboxProvider {
  switch (configuration.kind) {
    case "fake":
      return new FakeSandboxProvider();
    case "docker":
      return new DockerSandboxProvider(configuration.docker);
    case "daytona": {
      const { apiKey, ...settings } = configuration.daytona;
      return new DaytonaSandboxProvider(settings, createDaytonaSdkApi(apiKey));
    }
    case "local-process":
      return new LocalProcessSandboxProvider(configuration.localProcess);
  }
}
