import type { ThreadSummary } from "@barrack/protocol";
import { availableLifecycleActions, describeSandboxBanner } from "../presentation/describe-sandbox";
import type { LifecycleRequestState } from "../thread-state/thread-state";

type SandboxControlsProperties = {
  thread: ThreadSummary;
  request: LifecycleRequestState;
  onStop: () => void;
  onResume: () => void;
  onRequestDeletion: () => void;
  onConfirmDeletion: () => void;
  onCancelDeletion: () => void;
};

/**
 * What the thread's sandbox is doing, and what the user can do about it:
 * stop it, resume it, or delete the thread, which asks for confirmation
 * first since it cannot be undone.
 */
export function SandboxControls(properties: SandboxControlsProperties) {
  const { thread, request } = properties;
  const banner = describeSandboxBanner(thread.sandbox);
  const actions = availableLifecycleActions(thread.sandbox);
  const isSending = request.name === "sending";
  return (
    <section className="sandbox-controls" aria-label="Sandbox">
      {banner !== undefined && (
        <p
          className={
            banner.tone === "warning" ? "sandbox-banner sandbox-banner-warning" : "sandbox-banner"
          }
          role="status"
        >
          {banner.text}
        </p>
      )}
      {request.name === "confirming_delete" ? (
        <DeletionConfirmation
          onConfirm={properties.onConfirmDeletion}
          onCancel={properties.onCancelDeletion}
        />
      ) : (
        <div className="sandbox-actions">
          {actions.canStop && (
            <button type="button" disabled={isSending} onClick={properties.onStop}>
              {request.name === "sending" && request.action === "stop" ? "Stopping…" : "Stop"}
            </button>
          )}
          {actions.canResume && (
            <button type="button" disabled={isSending} onClick={properties.onResume}>
              {request.name === "sending" && request.action === "resume" ? "Resuming…" : "Resume"}
            </button>
          )}
          {actions.canDelete && (
            <button
              type="button"
              className="danger-button"
              disabled={isSending}
              onClick={properties.onRequestDeletion}
            >
              {request.name === "sending" && request.action === "delete" ? "Deleting…" : "Delete"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function DeletionConfirmation({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="deletion-confirmation" role="alertdialog" aria-label="Delete this thread?">
      <p>Delete this thread? Its sandbox, its files and its whole history are removed for good.</p>
      <div className="sandbox-actions">
        <button type="button" className="danger-button" onClick={onConfirm}>
          Delete for good
        </button>
        <button type="button" className="quiet-button" onClick={onCancel}>
          Keep it
        </button>
      </div>
    </div>
  );
}
