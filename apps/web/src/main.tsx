import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/app";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error('index.html has no element with id "root" to render the page into.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
