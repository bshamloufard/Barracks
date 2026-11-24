import { randomBytes } from "node:crypto";
import { ServiceProcess } from "./service-process.js";

/** Services get only what they need from the test runner's environment. */
const { PATH: searchPath } = process.env;

/** The browser origin the test clients claim; the control plane is told to allow it. */
export const testClientOrigin = "http://end-to-end-test.localhost";

export type RunningControlPlane = {
  /** For example `ws://127.0.0.1:41234`. */
  webSocketBaseUrl: string;
  supervisorToken: string;
  process: ServiceProcess;
};

/**
 * Starts the real control plane on a port the operating system picks, so
 * test runs never collide with each other or with `pnpm dev`, and reads the
 * port back from its log. It listens on loopback unless given the address of
 * another interface, such as the one Docker containers reach the host on.
 */
export async function startControlPlane(host = "127.0.0.1"): Promise<RunningControlPlane> {
  const supervisorToken = randomBytes(32).toString("hex");
  const controlPlane = new ServiceProcess("apps/control-plane/src/main.ts", {
    PATH: searchPath,
    BARRACK_SUPERVISOR_TOKEN: supervisorToken,
    BARRACK_CONTROL_PLANE_HOST: host,
    BARRACK_CONTROL_PLANE_PORT: "0",
    BARRACK_ALLOWED_CLIENT_ORIGINS: testClientOrigin,
  });
  const { port } = await controlPlane.waitForLogLine(
    "the control plane to listen",
    ({ msg }) => msg === "Control plane listening",
  );
  return {
    webSocketBaseUrl: `ws://${host}:${String(port)}`,
    supervisorToken,
    process: controlPlane,
  };
}

/** Starts the real sandbox supervisor for one thread, running the scripted fake agent. */
export function startSupervisor(
  controlPlane: RunningControlPlane,
  threadId: string,
): ServiceProcess {
  return new ServiceProcess("apps/sandbox-supervisor/src/main.ts", {
    PATH: searchPath,
    BARRACK_CONTROL_PLANE_URL: controlPlane.webSocketBaseUrl,
    BARRACK_THREAD_ID: threadId,
    BARRACK_SUPERVISOR_TOKEN: controlPlane.supervisorToken,
    BARRACK_AGENT_HARNESS: "fake",
  });
}
