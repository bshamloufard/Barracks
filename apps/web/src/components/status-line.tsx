import {
  type AgentAvailability,
  describeAgentAvailability,
} from "../presentation/describe-agent-availability";
import type { ConnectionState, ThreadState } from "../thread-state/thread-state";

export function StatusLine({ state }: { state: ThreadState }) {
  const isConnected = state.connection.name === "connected";
  const availability = describeAgentAvailability(state);
  return (
    <p className="status-line" aria-live="polite">
      <StatusItem isGood={isConnected} label={describeConnection(state.connection)} />
      {isConnected && (
        <StatusItem
          isGood={availability.name === "connected"}
          label={describeAvailability(availability)}
        />
      )}
      {isConnected && state.isSupervisorConnected && (
        <StatusItem isGood={true} label={state.isAgentWorking ? "Working…" : "Idle"} />
      )}
    </p>
  );
}

function StatusItem({ isGood, label }: { isGood: boolean; label: string }) {
  return (
    <span className="status-item">
      <span className={isGood ? "status-dot status-dot-good" : "status-dot"} aria-hidden="true" />
      {label}
    </span>
  );
}

function describeConnection(connection: ConnectionState): string {
  switch (connection.name) {
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting…";
    case "stopped":
      return connection.reason;
  }
}

function describeAvailability(availability: AgentAvailability): string {
  switch (availability.name) {
    case "loading":
      return "Loading the thread…";
    case "starting":
      return "Starting its sandbox…";
    case "waking":
      return "Waking the sandbox…";
    case "stopping":
      return "Stopping the sandbox…";
    case "stopped":
      return "Sandbox stopped";
    case "sandbox_failed":
      return availability.canResume ? "Its sandbox failed" : "Its sandbox is gone";
    case "deleting":
      return "Deleting…";
    case "connected":
      return "Agent connected";
    case "not_connected":
      return "Agent not connected";
  }
}
