import { parseThreadIdFromAddress } from "../thread-address";
import { ThreadView } from "./thread-view";

export function App() {
  const threadId = parseThreadIdFromAddress(window.location.search);
  if (!threadId.ok) {
    return (
      <main className="page">
        <p className="error-notice">{threadId.errorMessage}</p>
      </main>
    );
  }
  return <ThreadView threadId={threadId.value} />;
}
