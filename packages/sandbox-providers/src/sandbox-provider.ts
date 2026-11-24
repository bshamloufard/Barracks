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
   * been launched with exactly the environment and secrets in the request.
   *
   * A thread has at most one sandbox: if one already exists for the thread,
   * this throws `SandboxAlreadyExistsError` naming it, rather than creating a
   * second computer or quietly returning the old one.
   */
  create(request: SandboxCreationRequest): Promise<CreatedSandbox>;

  /**
   * Starts a stopped (or failed) sandbox, with its files as they were, and
   * launches its supervisor again with the environment and secrets it was
   * created with. Starting a sandbox that is already running does nothing,
   * except hand over `replacementSecrets`.
   */
  start(sandboxId: string, options?: SandboxStartOptions): Promise<void>;

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
   * The supervisor's plain settings, as environment variables: the control
   * plane's URL, the thread and the agent's settings. Nothing secret: a
   * sandbox's environment reaches every process started in it, the agent's
   * included (through `docker exec` or a provider's command interface), and
   * anyone who can inspect the sandbox. Providers pass it on unchanged.
   */
  supervisorEnvironment: Readonly<Record<string, string>>;
  /**
   * The supervisor's secrets, by name, such as `BARRACK_SUPERVISOR_TOKEN`.
   * Each reaches the supervisor as a file of that name in the directory its
   * `BARRACK_SUPERVISOR_SECRETS_DIRECTORY` names (`supervisor-secrets.ts`),
   * which only the supervisor's user can read, and which is kept across a
   * stop and a start. A provider never puts a secret in the sandbox's
   * environment, in a command's arguments, in what it reports about the
   * sandbox, or in a log line or error. Where the sandbox has no user for
   * the agent apart from the supervisor's (the local-process provider), the
   * agent can still read them.
   */
  supervisorSecrets: Readonly<Record<string, string>>;
};

export type SandboxStartOptions = {
  /**
   * Secrets to hand the supervisor instead of those of the same name it
   * has, before it is launched (a running one keeps what it read until it
   * is launched again). A creation taken over uses this to give a sandbox
   * an earlier attempt made the token it minted itself, whatever that
   * attempt managed to hand over. Treated as `supervisorSecrets` are.
   */
  replacementSecrets?: Readonly<Record<string, string>>;
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
 *   `start` may bring it back; `reason` says what went wrong, in words a
 *   user can read, and `cause` which kind of failure it was.
 * - `missing`: the provider has no such sandbox (never had, or destroyed).
 */
export type SandboxStatus =
  | { state: "starting" | "running" | "stopping" | "stopped" | "missing" }
  | { state: "failed"; cause: SandboxFailureCause; reason: string };

/**
 * Why a sandbox failed, as far as its provider can tell, so the caller can
 * say what to do about it without knowing the provider:
 *
 * - `supervisor-refused-to-start`: the supervisor found its configuration
 *   or its sandbox unusable and exited at once (exit code 78, `EX_CONFIG`);
 *   starting it again fails the same way until the installation is fixed.
 * - `supervisor-exited`: the supervisor ended with an error after starting.
 * - `out-of-memory`: the sandbox reached its memory limit and was killed.
 * - `out-of-disk`: the sandbox's disk, or the host's, was full.
 * - `provider-fault`: the provider reports a fault of its own.
 */
export type SandboxFailureCause =
  | "supervisor-refused-to-start"
  | "supervisor-exited"
  | "out-of-memory"
  | "out-of-disk"
  | "provider-fault";

/** The exit code with which the supervisor says it refused to start (`EX_CONFIG` in sysexits.h). */
export const supervisorRefusedToStartExitCode = 78;

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
