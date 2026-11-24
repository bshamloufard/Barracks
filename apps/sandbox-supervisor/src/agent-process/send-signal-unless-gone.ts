/** Sends a signal, treating a process that has already ended as nothing to do. */
export function sendSignalUnlessGone(processId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(processId, signal);
  } catch (error) {
    if (!isNoSuchProcessError(error)) {
      throw error;
    }
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
