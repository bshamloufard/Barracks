import { parsePageAddress } from "../page-address";
import { SessionGate } from "./session-gate";
import { ThreadListPage } from "./thread-list-page";
import { ThreadView } from "./thread-view";

export function App() {
  const address = parsePageAddress(window.location.search);
  if (!address.ok) {
    return (
      <main className="page">
        <p className="error-notice">{address.errorMessage}</p>
      </main>
    );
  }
  return (
    <SessionGate>
      {address.value.page === "thread-list" ? (
        <ThreadListPage />
      ) : (
        <ThreadView threadId={address.value.threadId} />
      )}
    </SessionGate>
  );
}
