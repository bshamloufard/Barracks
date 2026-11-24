import { identifierSchema } from "@barrack/protocol";
import { ThreadView } from "./thread-view";

/** Milestone 1 has no thread list: the thread comes from `?thread=` and defaults to `local`. */
const defaultThreadId = "local";

export function App() {
  const threadId = new URLSearchParams(window.location.search).get("thread") ?? defaultThreadId;
  if (!identifierSchema.safeParse(threadId).success) {
    return (
      <main className="page">
        <p className="error-notice">
          The thread in the address is not valid. Use <code>?thread=</code> followed by a name of 1
          to 256 characters.
        </p>
      </main>
    );
  }
  return <ThreadView threadId={threadId} />;
}
