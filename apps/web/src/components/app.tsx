import { type PageAddress, parsePageLocation } from "../page-address";
import { GithubCallbackPage } from "./github-callback-page";
import { SessionGate } from "./session-gate";
import { SettingsPage } from "./settings-page";
import { ThreadListPage } from "./thread-list-page";
import { ThreadView } from "./thread-view";

export function App() {
  const address = parsePageLocation(window.location.pathname, window.location.search);
  if (!address.ok) {
    return (
      <main className="page">
        <p className="error-notice">{address.errorMessage}</p>
      </main>
    );
  }
  return (
    <SessionGate>
      <Page address={address.value} />
    </SessionGate>
  );
}

function Page({ address }: { address: PageAddress }) {
  switch (address.page) {
    case "thread-list":
      return <ThreadListPage />;
    case "thread":
      return <ThreadView threadId={address.threadId} />;
    case "settings":
      return <SettingsPage />;
    case "github-callback":
      return <GithubCallbackPage code={address.code} state={address.state} />;
  }
}
