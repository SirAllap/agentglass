import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
// First among the app's own modules: it reads whether the launch cover is up
// (web/index.html) before anything else can change the page.
import { coverMounted } from "./lib/cover.ts";
import App from "./App.tsx";
import { PairScreen } from "./PairScreen.tsx";
import { adoptServer } from "./lib/api.ts";
import { ticketFromUrl, clearTicketFromUrl } from "./lib/pairing.ts";
import { followServerChanges } from "./lib/desktop.ts";
import { applyTheme, initialTheme, watchThemeStorage, watchSystemTheme, watchDesktopPalette } from "./lib/themes.ts";
import { restoreScale } from "./lib/uiScale.ts";
import "./index.css";
import "./fonts.ts"; // bundled monospace faces — see fonts.ts

// Restoring browser state paints this document only. Machine-wide theme output
// requires a fresh picker gesture; a page load may be a smoke test or another
// automated client and must not repaint a user's running tools.
applyTheme(initialTheme());
watchThemeStorage();
// When the mode is "System", follow the OS between the two serious defaults live.
watchSystemTheme();
// And, on a desktop that publishes its palette, wear it in "System" and follow
// its theme switches live. Does nothing anywhere else.
watchDesktopPalette();
// The webview always launches at 100%, so the saved zoom has to be re-asked for
// on every start. Fire-and-forget: it resolves a tick later and the window
// reflows into it, which is far less jarring than blocking the first paint.
restoreScale();

/*
 * There is one application now.
 *
 * This used to be a fork — `phoneLayoutNow()` off viewport width, pointer type,
 * a saved override and a server-planted "you are remote" flag, choosing between
 * the cockpit and a companion built for a phone. The companion is gone and the
 * native app replaced it, so every browser that reaches this file gets the
 * cockpit: a narrow laptop window, a tablet, and a phone that opens the QR link
 * alike.
 *
 * Worth saying plainly, because the fork was a capability gate and not only a
 * layout one: a device that pairs over the network now lands on the terminal,
 * git write access and docker control instead of a read-mostly queue. That is
 * not a hole this file was plugging — the token's scope is enforced by the
 * server per request (see DeviceScope), and a UI that hid the buttons never
 * stopped anything. The reason the companion existed at all is the reason it
 * could not stay: `crypto.subtle` is secure-context only, so the pairing
 * handshake is impossible over `http://192.168.x.x` and the one device the
 * companion was for could never complete it.
 */

// The shell restarts its sidecar when remote access is toggled or a link is
// revoked. Adopt the new origin/token in place rather than reloading the app.
followServerChanges();

const root = ReactDOM.createRoot(document.getElementById("root")!);

/** Tells the launch cover React has committed. An effect here runs after every
 *  effect below it, so each panel has taken its hold on the cover by then. */
function Mounted({ children }: { children: React.ReactNode }) {
  useEffect(() => { coverMounted(); }, []);
  return <>{children}</>;
}

const mount = (tree: React.ReactNode) => root.render(<React.StrictMode><Mounted>{tree}</Mounted></React.StrictMode>);

/**
 * A page opened from the QR has a handshake to finish before it has an
 * application.
 *
 * Decided out here rather than inside App: this device holds no credential yet,
 * so every request the tree makes on mount would come back 401 and the first
 * thing the user would see is an app failing to load behind a pairing form.
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
        mount(<App />);
      }}
    />
  );
} else {
  mount(<App />);
}
