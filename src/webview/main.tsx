/**
 * Webview entry point.
 *
 * No `StrictMode`. It double-invokes effects in development to surface impure ones, and
 * every effect here that runs twice costs a git subprocess — the model read, the pull
 * request fetch. The build is the same either way (this is not a development server), so it
 * would only slow the first paint.
 */
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { readHostSettings } from "./settings";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("No #root to mount the smartlog into.");
}
createRoot(container).render(
  <App settings={readHostSettings(document.body)} />
);
