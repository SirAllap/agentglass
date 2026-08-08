# A browser in agentglass — tier 1

> **Status — shipped.** This is the design note as it was written before the
> feature was built, kept as the record of *why* `<webview>` and not
> `WebContentsView`. The view exists now: `web/src/components/BrowserPanel.tsx`,
> `id: "browser"` in `views.ts` (key `b`, desktop builds only). Two things have
> dated since: it is no longer the "seventh" view — the 0.8 redesign made the
> workspace the whole window and the rail carries ten — and where the note below
> says the workspace is an "overlay", read "the view layer". The mount-once,
> toggle-visibility model it leans on is unchanged, which is why the `<webview>`
> decision still holds.

The desktop-only viewer: a workspace view holding a real page, with an
address bar and back/forward/reload. No profiles, no cookie import, no agent
driving. Those are tier 2 and 3, and the point of stopping here is to find out
whether the thing gets used before paying for them.

> **Since:** it did get used, and two of the three were paid for. Agents drive
> it (`server/src/browserdrive.ts`, `bin/agentglass-browser`, the browser-use
> skill), and logins can be brought in from a Firefox-family browser
> (`server/src/cookieimport.ts`) — because Electron cannot host a password
> manager, so importing cookies is the only way a page behind a login works
> here. Tabs and profiles remain undone. The non-goals list below is kept as it
> was written, with the two that moved marked, rather than quietly edited: what
> a decision cost is more useful than a tidy list.

Branch `browser/desktop-viewer`, worktree `../agentglass-browser`, cut from
local `main` (13 commits ahead of origin at the time) so it carries today's work
rather than a stale origin.

---

## The one decision that shapes everything

Electron offers two ways to put a page inside an app, and they are not
interchangeable here.

**`WebContentsView`** is the modern one, and the wrong one for this app. It is a
main-process object positioned in *window* coordinates: it floats above the DOM
rather than living in it. The workspace is an overlay with rounded corners whose
views all stay mounted and merely flip visibility (`Workspace.tsx` — "switching
only flips visibility", so a half-written commit message survives a trip to the
diff). A `WebContentsView` would ignore that: it would sit over the rounded
frame, occlude every menu and dialog the app opens, and need its bounds
recomputed by hand on resize, on view switch, and on every workspace open/close.

**`<webview>`** is the older one, discouraged in Electron's own docs, and the
right one here. It is a DOM element: it lays out, clips, hides and z-orders like
anything else, so the existing "mount once, toggle visibility" model just works.
Orca reached the same conclusion — `src/main/browser/browser-backend.ts` is
titled "Electron `<webview>` (renderer backend)".

Cost of that choice, taken with eyes open: `webviewTag` is a security surface
Electron turns off by default, so it comes with hardening (below), and guest key
events do not reach the renderer (also below).

---

## Touchpoints

Seven files. Nothing here is speculative — each is the place the feature has to
attach given how the app is already built.

### 1. `electron/main.js`

- **Enable the tag.** `webPreferences` at the `new BrowserWindow` call (~465)
  currently carries only `preload`. Add `webviewTag: true`.
- **Harden the attach.** Add a `will-attach-webview` handler on the window's
  `webContents`: delete `params.preload`, force `params.nodeIntegration = false`
  and `contextIsolation = true`, and reject any `src` that is not `http(s):`.
  This is the guard that makes enabling the tag defensible — without it, a page
  can ask for privileges the app never intended to hand out.
- **Give the guest its own session.** A named `partition` (e.g.
  `persist:agentglass-browser`) so browsing never touches the app's own session
  or the `agentglass://` privileged scheme. This is also the seam tier 2's
  profiles would widen.
- **Link routing.** `setWindowOpenHandler` (~558) and `will-navigate` (~562)
  currently send everything that is not `APP_ORIGIN` to the system browser. This
  is where "open in the built-in browser instead" hooks in, and it is Orca's
  "Link Routing" setting. Tier 1 should leave the default alone (system browser)
  and only add the plumbing — changing where every link in the app opens is a
  behaviour change that deserves its own decision, not a side effect.

### 2. `electron/preload.js`

Extend the `window.agentglass` bridge with what the renderer cannot ask for
itself — realistically just `browser: true` as a capability flag. Navigation
itself is `<webview>` DOM API and needs no IPC, which is a large part of why
this tier is cheap.

### 3. `web/src/lib/desktop.ts`

Add the capability to `DesktopBridge` and export a `hasBrowser()` alongside the
existing detectors. **This file is the whole reason tier 1 is days rather than
weeks** — the pattern for "native shell only, degrade in a browser tab" already
exists and is documented at the top of the file.

### 4. `shared/types.ts` (~554)

`ViewId` gains `"browser"`. It is shared deliberately: the server validates
`POST /control { cmd: "view", to }` against it, so the type is the contract
between the rail and the remote-control endpoint.

### 5. `web/src/components/workspace/views.ts`

One entry in `VIEWS`. Needs a `key` letter that is not already taken —
`g d p o t c` are gone; **`b` is free**. Order matters: `VIEWS` order *is* the
rail order and ⌘1..⌘N index into it, so appending is the only change that does
not renumber everyone's muscle memory.

### 6. `web/src/components/workspace/icons.tsx`

A `BrowserIcon` in the house style (the existing ones are inline SVG taking a
`size` prop).

### 7. `web/src/components/BrowserPanel.tsx` — new

The view itself: address bar, back/forward/reload/home, and the `<webview>`.
Mirrors `PrView`'s signature (`{ active }`) so the workspace can mount it like
the rest.

---

## The part that will take longer than it looks

**Keyboard.** A focused `<webview>` guest is its own Chromium process, and its
key events never reach the renderer. Every app shortcut — the ⌘1..⌘N view
switches, the workspace close — stops working the moment the page has focus.
Orca's `browser-guest-ui.ts` carries four separate comments about exactly this,
covering shortcut forwarding, page zoom, and both reload flavours. Budget for it
explicitly; it is not a polish item, it is the difference between a browser tab
and a trap.

The tier-1 answer can be small: forward a fixed allowlist of chords from the
guest via `before-input-event` in main, rather than Orca's general mechanism.

**Non-goals, stated so they do not creep in:** profiles, ~~cookie import~~ (done
— Firefox-family only; Chromium's values are keyring-encrypted and out of
reach), downloads, certificate prompts, camera/mic/WebAuthn permissions,
anti-detection. ~~Agent driving~~ is done too.
Each is a real subsystem — Orca's browser is 38 files and ~15,700 lines plus an
11.5 MB binary — and none is needed to answer "is a page inside agentglass
useful?".

---

## Mobile

`<webview>` does not exist in a phone browser, and the same bundle runs there.
`hasBrowser()` returns false and the rail entry is not rendered — the same
graceful absence `desktop.ts` already does for the other native-only features.

This is a real limit, not an oversight, and it is the argument for tier 3 being
a *server-side* browser with a screencast rather than more of this one: that
version would reach the phone and work headless, which is where the package
description's "from your desk or your phone" points.

---

## Order of work

1. `webviewTag` + `will-attach-webview` hardening + partition, with a throwaway
   hard-coded URL. Proves the guest renders inside the rounded overlay and
   clips correctly before any UI is built.
2. Capability flag through preload → `desktop.ts`.
3. `ViewId`, `VIEWS` entry, icon, empty panel. Rail and ⌘-switching working.
4. Address bar and navigation controls.
5. Keyboard forwarding.
6. Home page setting, persisted where the app keeps its other UI preferences.

Steps 1–3 are the ones that de-risk it. If the guest does not behave inside the
overlay, that is known on day one rather than after the address bar is built.

---

## How it gets verified

The app has no browser-driving test harness, and `<webview>` behaviour is not
unit-testable. What *is* testable, and now is:

- URL normalisation and the search-vs-URL decision in the address bar (pure, and
  the place typos become searches) — `web/test/browser-url.test.ts`.
- The `will-attach-webview` guard: given hostile params, assert the dangerous
  ones are stripped. This section asked for that test when the browser shipped
  and nothing covered it until the Electron 43 upgrade needed the guard proved.
  The decision now lives on its own in `electron/guest-guard.js` — importable,
  with no `electron` require in it — and is covered by
  `web/test/browser-guest-guard.test.ts`.

The half a unit test cannot reach was driven once against a live Electron 43
build, from the renderer, which is the process that would be compromised in the
attack the guard exists to stop. Recorded here because reproducing it is a
half-hour otherwise:

| guest | result |
| --- | --- |
| `http://…` on `persist:agentglass-browser` | attaches |
| `http://…` on `persist:agentglass-browser-work2` (a profile) | attaches |
| `about:blank` | attaches |
| `file:///etc/passwd` | never attaches — `getWebContentsId()` throws |
| partition `persist:agentglass` (the APP's own session) | never attaches |
| partition `persist:agentglass-browser/../agentglass` | never attaches |
| `https://user:pass@host/` | never attaches |
| a legitimate guest that also asks for `preload`, `nodeintegration=on` and `webpreferences=contextIsolation=no,sandbox=no,webSecurity=no` | attaches, stripped: inside it `window.agentglass`, `window.process` and `window.require` are all `undefined` |

The last row is the one that matters — the guard does not refuse a guest for
asking, it takes the bridge away, and the guest cannot tell the difference from
never having had one. Zoom (0 → 1.5) and `findInPage` both worked on the same
guest, so nothing was broken to get there.

The rest is manual, in the installed Electron app — which, per this repo's
recent history, means rebuilding with `electron/install-local.sh` **and checking
the md5 of the installed bundle against `web/dist`**, because that script
swallows `cp` failures and reports success regardless.
