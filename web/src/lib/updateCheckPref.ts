// Whether this window asks for a newer release by itself.
//
// The desktop app looks at the release feed once shortly after launch and then
// every six hours (updateStore.ts), which is a request to the repository the app
// was installed from. On is what the app has always done, so it stays the
// default; off means the feed is asked only when the person presses "Check for
// updates" on the About page.
//
// In localStorage like the window's other preferences: it decides what this
// window's timer does, and nothing else reads it.

const KEY = "agentglass.update.auto";

export const AUTO_CHECK_DEFAULT = true;

export function autoCheckUpdates(): boolean {
  try { const v = localStorage.getItem(KEY); return v === null ? AUTO_CHECK_DEFAULT : v !== "0"; } catch { return AUTO_CHECK_DEFAULT; }
}

export function setAutoCheckUpdates(on: boolean): void {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private mode: it holds for this window only */ }
}
