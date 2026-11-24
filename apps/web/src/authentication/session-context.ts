import { createContext, useContext } from "react";
import type { SessionController } from "./session-controller";

/** The signed-in session, provided to every page once the user is signed in. */
export const SessionContext = createContext<SessionController | undefined>(undefined);

export function useSession(): SessionController {
  const session = useContext(SessionContext);
  if (session === undefined) {
    throw new Error("A page that needs the session was rendered outside SessionContext.");
  }
  return session;
}
