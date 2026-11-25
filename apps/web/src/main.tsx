import "./parse-without-eval";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { takeSignInReturn } from "./authentication/sign-in-link";
import { App } from "./components/app";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error('index.html has no element with id "root" to render the page into.');
}

// Before anything renders, so the address is clean from the first render on.
const signInReturn = takeSignInReturn(window);

createRoot(rootElement).render(
  <StrictMode>
    <App signInReturn={signInReturn} />
  </StrictMode>,
);
