import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { applyTheme, initialTheme } from "./lib/themes.ts";
import { restoreScale } from "./lib/uiScale.ts";
import "./index.css";

applyTheme(initialTheme());
// The webview always launches at 100%, so the saved zoom has to be re-asked for
// on every start. Fire-and-forget: it resolves a tick later and the window
// reflows into it, which is far less jarring than blocking the first paint.
restoreScale();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
