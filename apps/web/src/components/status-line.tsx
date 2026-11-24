import type { ConnectionState, ThreadState } from "../thread-state/thread-state";

export function StatusLine({ state }: { state: ThreadState }) {
  const isConnected = state.connection.name === "connected";
  return (
    <p className="status-line" aria-live="polite">
      <StatusItem isGood={isConnected} label={describeConnection(state.connection)} />
      {isConnected && (
        <StatusItem
          isGood={state.isSupervisorConnected}
          label={state.isSupervisorConnected ? "Agent connected" : "Agent not connected"}
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
