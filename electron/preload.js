// @ts-check
// Bridge between the web UI and the Electron shell. Exposes exactly the native
// capabilities the cockpit uses (fullscreen, window zoom, launch-at-login) on
// a single `window.agentglass` object, so web/src/lib/desktop.ts can detect the
// desktop and call them. Everything else stays browser-standard.

const { contextBridge, ipcRenderer } = require("electron");

// The parameter types below are not decoration: they are one end of a contract
// whose other end is `DesktopBridge` in web/src/lib/desktop.ts. The two files
// used to be able to drift apart in silence — this side is plain JavaScript
// that nothing type-checked — and a renderer calling with the wrong shape only
// showed up as a feature that quietly did nothing. `// @ts-check` at the top is
// what now makes that a build error instead.

/** A listener as `ipcRenderer.on` takes it: the event first, then whatever the
 *  main process sent. Written down once because every subscription below has to
 *  keep its handler in a `const` (removeListener needs the same reference), and
 *  a standalone const gets no contextual type from `on`.
 *
 *  The payload stays `any` on purpose. It arrives off the IPC wire, and the
 *  handler that receives it is the thing that decides what it is willing to
 *  believe about it — several below coerce it, which is the honest reading.
 * @typedef {(event: import("electron").IpcRendererEvent, ...args: any[]) => void} IpcListener */

contextBridge.exposeInMainWorld("agentglass", {
  desktop: true,
  platform: process.platform,
  // A <webview> exists here and does not in a phone's browser tab, so the
  // browser view asks before it draws itself. Announced as a capability rather
  // than inferred from `desktop`, because the two can come apart: an older
  // shell is still the desktop app and has no guest to give.
  browser: true,
  /** The default browsing session, and the stem every profile's partition is
   *  built from (`<this>-<slug>`). The renderer must not invent the stem: the
   *  main process refuses to attach a guest on anything outside that family,
   *  and the app's own session is deliberately not in it. */
  browserPartition: "persist:agentglass-browser",
  // Where the sidecar listens. The renderer is served from agentglass://app,
  // whose hostname says nothing about the API — without this the web app would
  // derive `http://app:4000` from location.hostname and reach nothing.
  //
  // Asked of the main process rather than assumed from the env: the port is not
  // knowable up front, since another app may already hold the preferred one and
  // the shell then moves aside (electron/main.js). Sync because api.ts reads
  // this during module evaluation.
  apiOrigin: (() => {
    try { return ipcRenderer.sendSync("ag:apiOrigin") || null; } catch { return null; }
  })() || `http://127.0.0.1:${Number(process.env.AGENTGLASS_PORT || 4000)}`,
  // The shared secret, when one is in force (remote access on, or a token set
  // in the environment). Sync for the same reason as apiOrigin: api.ts reads it
  // during module evaluation and there is no second chance to hand it over.
  // Null in the ordinary loopback-only case, where nothing requires a token.
  apiToken: (() => {
    try { return ipcRenderer.sendSync("ag:apiToken") || null; } catch { return null; }
  })(),
  remoteEnabled: () => ipcRenderer.invoke("ag:remoteEnabled"),
  /** @param {boolean} on */
  setRemote: (on) => ipcRenderer.invoke("ag:setRemote", on),
  revokeRemote: () => ipcRenderer.invoke("ag:revokeRemote"),
  // The browser element-picker copies through the MAIN process clipboard, not
  // navigator.clipboard. When you press C/S the focus is on the <webview> guest,
  // so a renderer clipboard write is denied for a document that is not focused
  // and fails silently — which is exactly why the picker said "copied" and
  // copied nothing. The main process needs neither focus nor a user gesture.
  // Both resolve true on success, false on failure, so the caller can stop
  // claiming a copy that did not happen.
  /** @param {string} text */
  copyText: (text) => ipcRenderer.invoke("ag:copyText", String(text ?? "")),
  /** @param {string} dataUrl */
  copyImage: (dataUrl) => ipcRenderer.invoke("ag:copyImage", String(dataUrl ?? "")),
  /** A PNG onto the disk, where a browser puts a download. Answers with the
   *  path, because "saved" without a where is a file somebody has to hunt.
   * @param {string} dataUrl @param {string} name */
  saveImage: (dataUrl, name) => ipcRenderer.invoke("ag:saveImage", String(dataUrl ?? ""), String(name ?? "")),
  // Fired when the sidecar has been restarted under the app: a new port, a new
  // token, or both. Carries them rather than asking the page to reload.
  /** @param {(p: { origin?: string | null; token?: string | null }) => void} fn */
  onServerChanged: (fn) => {
    /** @type {IpcListener} */
    const h = (_e, payload) => { try { fn(payload); } catch { /* renderer's problem */ } };
    ipcRenderer.on("ag:server-changed", h);
    return () => ipcRenderer.removeListener("ag:server-changed", h);
  },
  // Why there is no server, when there is no server. Null while one is up.
  //
  // Read synchronously here for the same reason `apiOrigin` is: a window that
  // opens after the shell has already given up — a reload, a second window —
  // has missed the event below and would otherwise show a fully configured
  // origin with nothing behind it. The subscription carries everything that
  // happens after this page loaded, in both directions: a failure, and the
  // `null` that says a restart worked.
  sidecarFailure: (() => {
    try { return ipcRenderer.sendSync("ag:sidecarFailure") || null; } catch { return null; }
  })(),
  /** Whether a server has been CONFIRMED, as opposed to not having failed yet.
   *  A function and not a captured value on purpose: the answer changes a few
   *  hundred milliseconds after this page loads, and the caller asks precisely
   *  when it does not yet know. */
  sidecarUp: () => {
    try { return ipcRenderer.sendSync("ag:sidecarUp") === true; } catch { return false; }
  },
  /** @param {(p: unknown) => void} fn */
  onServerFailed: (fn) => {
    /** @type {IpcListener} */
    const h = (_e, payload) => { try { fn(payload || null); } catch { /* renderer's problem */ } };
    ipcRenderer.on("ag:server-failed", h);
    return () => ipcRenderer.removeListener("ag:server-failed", h);
  },
  // The window's own controls, because the frame that used to carry them is
  // gone. See main.js for why.
  winMinimize: () => ipcRenderer.invoke("ag:winMinimize"),
  /** `why` is diagnostic only — how the control was activated and what had
   *  focus. See noteWindow in main.js: a window that stops being maximised has
   *  to be able to say who did it. */
  /** @param {string} [why] */
  winToggleMaximize: (why) => ipcRenderer.invoke("ag:winToggleMaximize", why),
  winClose: () => ipcRenderer.invoke("ag:winClose"),
  winIsMaximized: () => ipcRenderer.invoke("ag:winIsMaximized"),
  winState: () => ipcRenderer.invoke("ag:winState"),
  /** Pop the app menu under the "⋯" in our own bar. There is no menu bar —
   *  see main.js — so this is the only route to it.
   * @param {number} x @param {number} y */
  appMenu: (x, y) => ipcRenderer.invoke("ag:appMenu", x, y),
  /** The built-in browser's zoom, after a Ctrl+wheel or Ctrl+plus inside the
   *  page. The shell applies it (a zoom a frame late feels like it is fighting
   *  the wheel); this is only so the panel can show and remember the level.
   * @param {(level: number) => void} fn */
  onBrowserZoom: (fn) => {
    /** @type {IpcListener} */
    const h = (_e, level) => fn(level);
    ipcRenderer.on("ag:browser-zoom", h);
    return () => ipcRenderer.removeListener("ag:browser-zoom", h);
  },
  /** A page in the built-in browser asked for a window — a middle click, a
   *  `target="_blank"`, an OAuth popup. It used to be handed to the OS
   *  browser because there was nowhere else to put it; now it becomes a tab.
   * @param {(url: string) => void} fn */
  onBrowserOpenTab: (fn) => {
    /** @type {IpcListener} */
    const h = (_e, url) => fn(String(url));
    ipcRenderer.on("ag:browser-open-tab", h);
    return () => ipcRenderer.removeListener("ag:browser-open-tab", h);
  },
  /** A browser chord pressed while a PAGE had the focus — `t`, `l` or `f`.
   *  The guest is its own Chromium and its keys never reach us, so the shell
   *  forwards the three that need this app's own chrome: a new tab, the address
   *  bar, the find strip. Reload and back are handled in the shell and never
   *  arrive here — they belong to the page, and the focus stays on it.
   * @param {(key: string) => void} fn */
  onBrowserKey: (fn) => {
    /** @type {IpcListener} */
    const h = (_e, key) => fn(String(key));
    ipcRenderer.on("ag:browser-key", h);
    return () => ipcRenderer.removeListener("ag:browser-key", h);
  },
  /** "Search the web for…" from the page's context menu. The text rather than a
   *  url, because which engine to use is a setting that lives in the app.
   * @param {(text: string) => void} fn */
  onBrowserSearch: (fn) => {
    /** @type {IpcListener} */
    const h = (_e, text) => fn(String(text));
    ipcRenderer.on("ag:browser-search", h);
    return () => ipcRenderer.removeListener("ag:browser-search", h);
  },
  /** Point one guest's DevTools at another guest, so the inspector is a pane in
   *  this window rather than a floating OS window. Answers whether it landed —
   *  a floating inspector is a working one and an empty pane is not.
   * @param {{ guest: number; rect: unknown; x?: number; y?: number; zoom?: number }} req */
  browserDevtools: (req) => ipcRenderer.invoke("ag:browserDevtools", req),
  /** @param {{ guest: number }} req */
  browserDevtoolsClose: (req) => ipcRenderer.invoke("ag:browserDevtoolsClose", req),
  /** Where the pane is now, in CSS pixels. Sent rather than invoked: it lands on
   *  every frame of a drag, and waiting for a round trip to draw the next one is
   *  how a resize starts to feel like it is fighting the pointer.
   * @param {{ guest: number; rect: unknown }} req */
  browserDevtoolsRect: (req) => ipcRenderer.send("ag:browserDevtoolsRect", req),
  /** The inspector's OWN zoom — not the app's, not the page's.
   * @param {{ guest: number; level: number }} req */
  browserDevtoolsZoom: (req) => ipcRenderer.invoke("ag:browserDevtoolsZoom", req),
  /** …and the same zoom after a Ctrl+wheel or Ctrl+plus inside the inspector,
   *  which lands in that view and never reaches this one.
   * @param {(at: { guest: number; level: number }) => void} fn */
  onDevtoolsZoom: (fn) => {
    /** @type {IpcListener} */
    const h = (_e, at) => fn(at);
    ipcRenderer.on("ag:browser-devtools-zoom", h);
    return () => ipcRenderer.removeListener("ag:browser-devtools-zoom", h);
  },
  /** "Inspect" from the page's own context menu, with where it was clicked.
   * @param {(at: { x: number; y: number }) => void} fn */
  onBrowserInspect: (fn) => {
    /** @type {IpcListener} */
    const h = (_e, at) => fn(at);
    ipcRenderer.on("ag:browser-inspect", h);
    return () => ipcRenderer.removeListener("ag:browser-inspect", h);
  },
  /** Which tab is on screen, by its guest's WebContents id. The shell holds
   *  one "current browser" for the Ctrl+wheel zoom and for the screenshots an
   *  agent asks for, and only this side knows which tab that is.
   * @param {number} id */
  setActiveBrowserGuest: (id) => ipcRenderer.invoke("ag:browserActive", id),
  /** The whole page including what is below the fold, straight onto the
   *  clipboard. `capturePage` cannot: what was never painted has no frame.
   * @param {"copy" | "save"} [how] */
  captureFullPage: (how) => ipcRenderer.invoke("ag:captureFullPage", how),
  /** Another browser's SIDEBAR — its spaces, folders and pinned pages. Zen
   *  only: it is the one that keeps such a thing in a file.
   * @param {string} source */
  browserShelfRead: (source) => ipcRenderer.invoke("ag:browserShelfRead", source),
  /** The pages and bookmarks in another browser's profile, so the address bar
   *  can complete against somewhere you have actually been.
   * @param {{ source: string }} req */
  browserPlaces: (req) => ipcRenderer.invoke("ag:browserPlaces", req),
  /** The browsers on this machine whose logins could be brought in, with a
   *  count per site and no names and no values. Reading happens in a separate
   *  one-shot process — see main.js — so cookie values never reach here. */
  cookieSources: () => ipcRenderer.invoke("ag:cookieSources"),
  /** Bring the logins for these sites in. Confirmed by a native dialog in the
   *  main process, which this side can neither fake nor suppress.
   * @param {{ source: string; sites: string[] }} req */
  importCookies: (req) => ipcRenderer.invoke("ag:importCookies", req),
  /** And take them out again — these sites only, not the whole profile.
   * @param {{ sites: string[]; partitions?: string[] }} req */
  forgetCookies: (req) => ipcRenderer.invoke("ag:forgetCookies", req),
  /** A screenshot of the built-in browser, taken by the shell because a pane
   *  nobody is looking at produces no frames for the panel to capture. Null
   *  when there is no browser open. */
  /** `{ png, why }`: the failure is the interesting half, and it used to be a
   *  bare null that every caller reported as "the pane is not on screen". */
  /** @param {{ guestId?: number, scale?: number } | undefined} [opts] */
  captureBrowser: (opts) => ipcRenderer.invoke("ag:captureBrowser", opts),
  /** §4: register a script under `name` to run on the browser guest before
   *  every document's own scripts from now on. Re-registering the same name
   *  replaces it. `{ ok, error? }`.
   * @param {string} name @param {string} source @param {number} [guestId] */
  registerInitScript: (name, source, guestId) => ipcRenderer.invoke("ag:browserRegisterInitScript", { name, source, guestId }),
  /* §5: the DevTools protocol, relayed whole. `drain` takes the events that
     arrived since the last drain instead of sending a command. */
  /** @param {string} method @param {unknown} [params] @param {number} [guestId] */
  cdp: (method, params, guestId) => ipcRenderer.invoke("ag:browserCdp", { method, params, guestId }),
  /* The PERSON's zoom: `webContents.setZoomFactor` in the main process, which
     scales the page inside the box it has. Not the agent's `zoom` verb, which
     emulates a viewport — see the note on the handler. Omit `factor` to read. */
  zoom: (/** @type {number | undefined} */ factor, /** @type {number | undefined} */ guestId) => ipcRenderer.invoke("ag:browserZoom", { factor, guestId }),
  /** A tab's favicon as a `data:` URL, fetched by the shell on that tab's own
   *  session. Only URLs Chromium reported for that guest are accepted — see
   *  main.js. `img-src` allows `data:`, so the strip stops being six CSP
   *  violations a launch and starts showing icons again.
   *  @param {string} url @param {number} [guestId] */
  browserFavicon: (url, guestId) => ipcRenderer.invoke("ag:browserFavicon", { url, guestId }),
  cdpEvents: () => ipcRenderer.invoke("ag:browserCdp", { drain: true }),
  /** §13: apply session-level settings (proxy, extensions, cookies, DNS)
   *  through the Electron main process. */
  /** @param {Record<string, unknown>} req */
  sessionSettings: (req) => ipcRenderer.invoke("ag:browserSessionSettings", req),
  /** The system folder chooser, for picking a project. Resolves to a path, or
   *  null if it was cancelled. A browser tab has no equivalent, which is why
   *  the picker keeps a path box beside it.
   * @param {string} [start] */
  chooseFolder: (start) => ipcRenderer.invoke("ag:chooseFolder", start),
  /** Told, not polled: the window manager can maximise or fullscreen this
   *  window without asking us, and a glyph that guesses is a glyph that lies.
   * @param {(st: { max: boolean; full: boolean }) => void} fn */
  onWinState: (fn) => {
    /** @type {IpcListener} */
    const h = (_e, st) => fn({ max: !!st?.max, full: !!st?.full });
    ipcRenderer.on("ag:winState", h);
    return () => ipcRenderer.removeListener("ag:winState", h);
  },
  /** @param {boolean} on */
  setFullscreen: (on) => ipcRenderer.invoke("ag:setFullscreen", on),
  isFullscreen: () => ipcRenderer.invoke("ag:isFullscreen"),
  /** @param {number} factor */
  setZoom: (factor) => ipcRenderer.invoke("ag:setZoom", factor),
  autostartEnabled: () => ipcRenderer.invoke("ag:autostartEnabled"),
  /** @param {boolean} on */
  setAutostart: (on) => ipcRenderer.invoke("ag:setAutostart", on),
  /** Open the desktop's file manager with this file selected. Desktop only, so
   *  the caller checks for it rather than assuming — see desktop.ts.
   * @param {string} p */
  revealPath: (p) => ipcRenderer.invoke("ag:revealPath", p),
  powerStatus: () => ipcRenderer.invoke("ag:powerStatus"),
  /** @param {"on" | "agent" | "off"} mode */
  setPowerMode: (mode) => ipcRenderer.invoke("ag:setPowerMode", mode),
});
