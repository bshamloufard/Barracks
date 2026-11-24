import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Stands in for a sandbox that can restart its supervisor, which the
 * local-process provider cannot: a test makes this the provider's
 * supervisor command, so each thread's "sandbox" is this small process,
 * running the real supervisor as its child, with the sandbox's environment
 * and working directory.
 *
 * Usage: restartable-supervisor <record directory> <supervisor command...>
 *
 * - It writes `<record directory>/<thread id>.json` with its own process ID
 *   and its supervisor's (null while none runs), so a test can find and
 *   kill the supervisor of a given thread.
 * - A supervisor that ends is not restarted until this process receives
 *   SIGHUP, so a test decides how long the sandbox stays without one.
 * - SIGTERM or SIGINT is passed on to the supervisor, and this process
 *   exits with it, as a sandbox being stopped would.
 */

type SupervisorRecord = { wrapperProcessId: number; supervisorProcessId: number | null };

const [recordDirectory, executable, ...commandArguments] = process.argv.slice(2);
const { BARRACK_THREAD_ID: threadId } = process.env;
if (recordDirectory === undefined || executable === undefined || threadId === undefined) {
  throw new Error(
    "Usage: restartable-supervisor <record directory> <supervisor command...>, with BARRACK_THREAD_ID set.",
  );
}
const recordPath = path.join(recordDirectory, `${threadId}.json`);
let supervisor: ChildProcess | undefined;
let isStopping = false;

function writeRecord(): void {
  const record: SupervisorRecord = {
    wrapperProcessId: process.pid,
    supervisorProcessId: supervisor?.pid ?? null,
  };
  writeFileSync(recordPath, JSON.stringify(record));
}

function startSupervisor(command: string): void {
  const child = spawn(command, commandArguments, { stdio: "inherit" });
  supervisor = child;
  writeRecord();
  child.once("exit", () => {
    supervisor = undefined;
    writeRecord();
    if (isStopping) {
      process.exit(0);
    }
  });
}

process.on("SIGHUP", () => {
  if (supervisor === undefined && !isStopping) {
    startSupervisor(executable);
  }
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    isStopping = true;
    if (supervisor === undefined) {
      process.exit(0);
    }
    supervisor.kill(signal);
  });
}

// Signal listeners do not keep Node running, so without this the sandbox
// would end with its supervisor and could not start it again.
setInterval(() => undefined, 60_000);

startSupervisor(executable);
