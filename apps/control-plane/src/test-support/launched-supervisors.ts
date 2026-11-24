import {
  type FakeSandboxLaunch,
  FakeSandboxProvider,
  type LaunchedSupervisor,
} from "@barrack/sandbox-providers";
import { connectFakeSupervisor, type FakeSupervisor } from "./test-peers.js";

/**
 * A fake provider whose sandboxes run a fake supervisor: each time one
 * starts, a supervisor connects to the control plane with the thread's
 * token and says hello, and it disconnects when the sandbox stops, as a
 * real sandbox's would. Each launch is a new supervisor process, so a new
 * instance; how far it had been handed user messages is kept on the
 * sandbox's disk, as the real supervisor keeps it.
 */
export class LaunchedSupervisors {
  readonly provider: FakeSandboxProvider;
  readonly #supervisorsByThread = new Map<string, FakeSupervisor[]>();
  #controlPlaneBaseUrl: string | undefined;

  constructor() {
    this.provider = new FakeSandboxProvider({
      supervisorLauncher: (launch) => this.#launch(launch),
    });
  }

  /** Where launched supervisors connect; set once the control plane listens. */
  connectTo(controlPlane: { baseUrl: string }): void {
    this.#controlPlaneBaseUrl = controlPlane.baseUrl;
  }

  /** How many supervisors the thread's sandbox has launched. */
  launchCount(threadId: string): number {
    return this.#supervisorsByThread.get(threadId)?.length ?? 0;
  }

  /** The thread's most recently launched supervisor. */
  latest(threadId: string): FakeSupervisor {
    const supervisor = this.#supervisorsByThread.get(threadId)?.at(-1);
    if (supervisor === undefined) {
      throw new Error(`No supervisor was launched for ${threadId}.`);
    }
    return supervisor;
  }

  /** Every user message any of the thread's supervisors was handed, in order. */
  messagesHandedOver(threadId: string): string[] {
    return (this.#supervisorsByThread.get(threadId) ?? []).flatMap((supervisor) =>
      supervisor.deliveredUserMessages.map((message) => message.text),
    );
  }

  /** Acknowledges the messages handed to the latest supervisor, and notes it on the sandbox's disk. */
  acknowledgeDelivery(threadId: string, files: Map<string, string> | undefined): void {
    const supervisor = this.latest(threadId);
    const throughSequence = Math.max(
      0,
      ...supervisor.deliveredUserMessages.map((message) => message.sequence),
    );
    supervisor.acknowledgeUserMessages(throughSequence);
    files?.set(deliveredThroughFile, String(throughSequence));
  }

  async #launch(launch: FakeSandboxLaunch): Promise<LaunchedSupervisor> {
    const baseUrl = this.#controlPlaneBaseUrl;
    const { BARRACK_SUPERVISOR_TOKEN: token } = launch.supervisorEnvironment;
    if (baseUrl === undefined || token === undefined) {
      throw new Error("A sandbox started before the control plane was known, or without a token.");
    }
    const supervisor = await connectFakeSupervisor(baseUrl, launch.threadId, token);
    await supervisor.sayHello(Number(launch.files.get(deliveredThroughFile) ?? 0));
    const supervisors = this.#supervisorsByThread.get(launch.threadId) ?? [];
    supervisors.push(supervisor);
    this.#supervisorsByThread.set(launch.threadId, supervisors);
    return { stop: () => supervisor.close() };
  }
}

const deliveredThroughFile = "supervisor/delivered-through";
