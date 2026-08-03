import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { MobileApp } from "./mobile/MobileApp.tsx";
import { PairScreen } from "./PairScreen.tsx";
import { adoptServer, IS_DESKTOP } from "./lib/api.ts";
import { ticketFromUrl, clearTicketFromUrl } from "./lib/pairing.ts";
import { phoneLayoutNow } from "./lib/viewport.ts";
import { followServerChanges } from "./lib/desktop.ts";
import { applyTheme, initialTheme, watchThemeStorage, watchSystemTheme } from "./lib/themes.ts";
import { applyUiFont } from "./lib/uiFont.ts";
import { restoreScale } from "./lib/uiScale.ts";
import "./index.css";

// Re-broadcast on boot, not only on a deliberate pick: the persisted theme IS
// the user's last deliberate choice, and without this the machine's tmux/nvim
// kept whatever palette was synced the last time the switcher was clicked —
// days stale — while the cockpit itself moved on. Gated to the desktop shell so
// a phone or a paired browser opening the cockpit never repaints the host's
// terminals; see IS_DESKTOP.
applyTheme(initialTheme(), { sync: IS_DESKTOP });
watchThemeStorage();
// When the mode is "System", follow the OS between the two serious defaults live.
watchSystemTheme();
// The saved monospace face, applied to --font-mono for the whole cockpit.
applyUiFont();
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

const root = ReactDOM.createRoot(document.getElementById("root")!);

const mount = (tree: React.ReactNode) => root.render(<React.StrictMode>{tree}</React.StrictMode>);

/**
 * A page opened from the QR has a handshake to finish before it has an
 * application.
 *
 * Decided out here rather than inside the apps, for the same reason the phone
 * check is: this device holds no credential yet, so every request either tree
 * makes on mount would come back 401 and the first thing the user would see is
 * an app failing to load behind a pairing form.
 *
 * Handing the token to `adoptServer` rather than reloading means the app mounts
 * straight into a working session — a reload here would drop the URL the QR
 * carried and land somebody on a cold start with no explanation of what just
 * happened.
 */
const invitation = ticketFromUrl(location.href);
if (invitation) {
  mount(
    <PairScreen
      ticket={invitation}
      onPaired={(token) => {
        adoptServer({ token });
        clearTicketFromUrl();
        mount(<Root />);
      }}
    />
  );
} else {
  mount(<Root />);
}
