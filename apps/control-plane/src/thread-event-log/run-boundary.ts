import type { ThreadEvent } from "@barrack/protocol";

/**
 * Whether an event opens a run, closes one, or neither. A run is open from
 * `agent_run_started` until the `agent_run_settled` or `agent_failed` that
 * ends it, whoever records that end.
 */
export type RunBoundary = "opens_run" | "closes_run" | "none";

export function runBoundaryOf(event: ThreadEvent): RunBoundary {
  switch (event.type) {
    case "agent_run_started":
      return "opens_run";
    case "agent_run_settled":
    case "agent_failed":
      return "closes_run";
    default:
      return "none";
  }
}
