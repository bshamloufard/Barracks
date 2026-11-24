/**
 * The boundary between the control plane and the computers that threads run
 * on. A provider brings a sandbox into existence, starts it, stops it,
 * destroys it, reports what state it is in, and hands out an address for a
 * service running inside it. Everything else happens through the supervisor
 * process inside the sandbox, which connects out to the control plane.
 *
 * Providers hold no lifecycle policy. The control plane alone decides when a
 * sandbox starts, stops and is destroyed; a provider never does any of these
 * on a timer of its own. (A provider may move a stopped sandbox to cheaper
 * storage, as Daytona's archive does, because that keeps its files and it
 * stays `stopped`.)
 *
 * Every operation that takes a sandbox identifier acts on exactly that
 * sandbox. None of them ever creates a sandbox or substitutes another one,
 * so a stored identifier can never silently come to mean a different
 * computer.
 *
 * Failures are thrown as the errors in `sandbox-provider-errors.ts`, so the
 * caller can tell a missing sandbox from a provider that is unreachable from
 * one that refused the request.
 */
export interface SandboxProvider {
  /**
   * Brings a new sandbox into existence for a thread and starts it. When the
   * returned promise resolves the sandbox is running and its supervisor has
   * been launched with exactly the environment in the request.
   *
   * A thread has at most one sandbox: if one already exists for the thread,
   * this throws `SandboxAlreadyExistsError` naming it, rather than creating a
   * second computer or quietly returning the old one.
   */
  create(request: SandboxCreationRequest): Promise<CreatedSandbox>;

  /**
   * Starts a stopped (or failed) sandbox, with its files as they were, and
   * launches its supervisor again with the environment it was created with.
   * Starting a sandbox that is already running does nothing.
   */
  start(sandboxId: string): Promise<void>;

  /**
   * Stops a running sandbox, keeping its files so that `start` can resume it.
   * Its supervisor and every process inside it end. Stopping a sandbox that
   * is already stopped does nothing.
   */
  stop(sandboxId: string): Promise<void>;

  /**
   * Destroys a sandbox and everything on its disk. Destroying a sandbox that
   * does not exist (or no longer does) does nothing, so a destroy that was
   * interrupted can simply be repeated.
   */
  destroy(sandboxId: string): Promise<void>;

  /**
   * Reports what state a sandbox is in now. The control plane needs this to
   * reconcile what it believes with what is true after it restarts, or after
   * the provider stops or loses a sandbox on its own (a crashed supervisor, a
   * restarted host, a provider outage). A sandbox the provider does not know
   * is reported as `missing` rather than thrown as an error, because during
   * reconciliation that is an answer, not a failure.
   */
  getStatus(sandboxId: string): Promise<SandboxStatus>;

  /**
   * Returns an address at which a service listening on `port` inside a
   * running sandbox can be reached, together with whatever expiry and
   * authorisation the provider attaches to it. This exists for the live
   * desktop view.
   */
  getServiceAddress(request: ServiceAddressRequest): Promise<ServiceAddress>;
}

export type SandboxCreationRequest = {
  /**
   * The thread the sandbox is for. Providers use it to label and name the
   * sandbox so that Barrack's sandboxes can be found and so that two threads
   * can never collide.
   */
  threadId: string;
  /**
   * The environment the supervisor runs with: the control plane's URL, the
   * thread, the supervisor's credentials and the agent's settings. Providers
   * treat it as opaque, pass it on unchanged, and never log or echo its
   * values, because it holds secrets.
   */
  supervisorEnvironment: Readonly<Record<string, string>>;
};

export type CreatedSandbox = {
  /**
   * Identifies the sandbox to the provider that created it, and to no other.
   * The control plane stores it and passes it back to every other operation.
   */
  sandboxId: string;
};

/**
 * - `starting`: on its way to running (being created, started or restored).
 * - `running`: running, with its supervisor launched.
 * - `stopping`: on its way to stopped.
 * - `stopped`: not running; its files are kept and `start` resumes it.
 * - `failed`: stopped by something other than the control plane, such as its
 *   supervisor exiting with an error or the provider reporting a fault.
 *   `start` may bring it back; `reason` says what went wrong.
 * - `missing`: the provider has no such sandbox (never had, or destroyed).
 */
export type SandboxStatus =
  | { state: "starting" | "running" | "stopping" | "stopped" | "missing" }
  | { state: "failed"; reason: string };

export type SandboxState = SandboxStatus["state"];

export type ServiceAddressRequest = {
  sandboxId: string;
  /** The port the service listens on inside the sandbox. */
  port: number;
  /**
   * How long the caller needs the address to keep working. Providers whose
   * addresses expire make them expire no later than this; providers whose
   * addresses do not expire ignore it.
   */
  validForSeconds: number;
};

export type ServiceAddress = {
  /** An `http://` or `https://` URL for the service. */
  url: string;
  /** When the address stops working, or `undefined` if it does not expire. */
  expiresAt: Date | undefined;
  /**
   * Who can use the address:
   * - `anyone-with-the-url`: the URL itself carries the authorisation, for
   *   this one port only, so it must only ever be shown to the thread's owner.
   * - `the-sandbox-host-only`: the URL is reachable only from the machine the
   *   sandboxes run on, and carries no authorisation of its own.
   */
  reachableBy: "anyone-with-the-url" | "the-sandbox-host-only";
};
