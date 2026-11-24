import { parsePageAddress } from "../page-address";
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
  if (address.value.page === "thread-list") {
    return <ThreadListPage />;
  }
  return <ThreadView threadId={address.value.threadId} />;
}
