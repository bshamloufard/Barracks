import {
  type ClientConfiguration,
  clientConfigurationPath,
  clientConfigurationSchema,
} from "@barrack/protocol";

/**
 * How this installation signs users in, asked of the control plane before
 * anything else, so one build of the page serves any installation.
 */
export async function fetchClientConfiguration(): Promise<ClientConfiguration> {
  let response: Response;
  try {
    response = await fetch(clientConfigurationPath);
  } catch {
    throw new Error("The control plane could not be reached. Check that it is running.");
  }
  const configuration = clientConfigurationSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  if (!response.ok || !configuration.success) {
    throw new Error(
      `The control plane did not say how to sign in (HTTP ${response.status}). Reload the page.`,
    );
  }
  return configuration.data;
}
