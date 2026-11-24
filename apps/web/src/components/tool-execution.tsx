import { describeDuration, summarizeToolArguments } from "../presentation/describe-tool-execution";
import type { ToolExecutionEntry, ToolExecutionOutcome } from "../thread-state/thread-state";

const statusLabels: Record<ToolExecutionOutcome["status"], string> = {
  running: "running",
  finished: "done",
  errored: "failed",
};

/** One compact row per tool execution; its output opens on demand. */
export function ToolExecution({ entry }: { entry: ToolExecutionEntry }) {
  const { outcome } = entry;
  return (
    <details className={`tool-execution tool-execution-${outcome.status}`}>
      <summary>
        <span className="tool-status">{statusLabels[outcome.status]}</span>
        <span className="tool-name">{entry.toolName}</span>
        <span className="tool-arguments">{summarizeToolArguments(entry.arguments)}</span>
      </summary>
      {outcome.status === "running" ? (
        <p className="quiet-note">Still running…</p>
      ) : (
        <>
          <pre className="tool-output">{outcome.output.text || "(no output)"}</pre>
          <p className="quiet-note">
            {outcome.output.isTruncated &&
              `Output truncated; ${outcome.output.originalSizeInBytes.toLocaleString()} bytes originally. `}
            {outcome.durationInMilliseconds !== undefined &&
              `Took ${describeDuration(outcome.durationInMilliseconds)}.`}
          </p>
        </>
      )}
    </details>
  );
}
