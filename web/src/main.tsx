import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { MobileApp } from "./mobile/MobileApp.tsx";
import { phoneLayoutNow } from "./lib/viewport.ts";
import { followServerChanges } from "./lib/desktop.ts";
import { applyTheme, initialTheme, watchThemeStorage } from "./lib/themes.ts";
import { restoreScale } from "./lib/uiScale.ts";
import "./index.css";

applyTheme(initialTheme());
watchThemeStorage();
// The webview always launches at 100%, so the saved zoom has to be re-asked for
// on every start. Fire-and-forget: it resolves a tick later and the window
// reflows into it, which is far less jarring than blocking the first paint.
restoreScale();

/**
 * A phone gets a different application, not a narrower one.
 *
 * Decided here, before React, rather than inside App: the cockpit mounts a
 * terminal, a live socket, charts and a radar on the way to its first paint,
 * and none of that should happen on a device that will never show them.
 * Rendering one tree or the other is also what keeps the phone UI honest — it
 * cannot quietly grow a dependency on desktop state it does not have.
 */
const phone = phoneLayoutNow();
// The stylesheet needs to know too: the cockpit pins html/body/#root to the
// viewport and hides overflow, which is correct for panels that scroll
// internally and fatal for a page that is meant to scroll as a whole.
document.documentElement.dataset.layout = phone ? "phone" : "desktop";
const Root = phone ? MobileApp : App;

// The shell restarts its sidecar when remote access is toggled or a link is
// revoked. Adopt the new origin/token in place rather than reloading the app.
followServerChanges();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
