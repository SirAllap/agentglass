/*
 * A stand-in for the `electron` module, so electron/main.js can be run by plain
 * node — no display, no window, nothing on anybody's screen.
 *
 * It exists for one question that cannot be answered any other way: does the
 * shell SURVIVE a sidecar that will not start, and does it say so? Measured on
 * the version before the fix, through this same harness: `spawn("bun")` with no
 * bun on PATH emitted an unhandled `error` and took the whole main process down
 * with it. A source-shape assertion cannot see that, and driving real Electron
 * needs a display this repo's tests do not have.
 *
 * Only the surface main.js touches at startup. If a future main.js reaches for
 * something that is not here, the harness will throw with the missing name in
 * it — that is a stub to extend, not a test to skip.
 */
const noop = () => {};
/** How many `ag:server-failed` messages have gone out. See `send`. */
let seenFailures = 0;

class FakeWebContents {
  constructor() {
    this.session = { setPermissionRequestHandler: noop, webRequest: { onBeforeRequest: noop } };
  }
  // The whole point of the harness: everything the shell tells the window comes
  // out here, one line per message, for the test to read off stdout.
  send(channel, payload) {
    console.log("AGX-IPC " + channel + " " + JSON.stringify(payload ?? null));
    /*
     * And leave as soon as the case has said what it came to say.
     *
     * Without it every case pays the harness's own 20s ceiling, and three cases
     * made a 60s test file. The ceiling stays — it is what catches a shell that
     * reports NOTHING, which is the original bug — but a run that has already
     * produced its evidence has nothing left to wait for. Exit 0 deliberately:
     * the test asserts the process did not die, so the harness must not be the
     * thing that makes it die.
     */
    if (channel === "ag:server-failed") {
      const want = Number(process.env.AGX_PROBE_EXIT_AFTER || 0);
      if (want && ++seenFailures >= want) setTimeout(() => process.exit(0), 50);
    }
  }
  on() {} once() {} setWindowOpenHandler() {}
  executeJavaScript() { return Promise.resolve(); }
  isDestroyed() { return false; }
  setZoomLevel() {} getZoomLevel() { return 0; }
}

const windows = [];
class BrowserWindow {
  constructor() { this.webContents = new FakeWebContents(); windows.push(this); }
  static getAllWindows() { return windows; }
  static fromWebContents() { return windows[0] ?? null; }
  loadURL() { return Promise.resolve(); }
  on() {} once() {} setBounds() {} getBounds() { return { x: 0, y: 0, width: 1, height: 1 }; }
  isMaximized() { return false; } maximize() {} unmaximize() {} minimize() {} close() {}
  show() {} focus() {} restore() {}
  isMinimized() { return false; } isVisible() { return true; }
  isFullScreen() { return false; } setFullScreen() {}
  isDestroyed() { return false; }
}

const fakeSession = () => ({
  setPermissionRequestHandler: noop,
  webRequest: { onBeforeRequest: noop },
  setSpellCheckerEnabled: noop,
  clearStorageData: () => Promise.resolve(),
  cookies: { get: () => Promise.resolve([]) },
  protocol: { handle: noop },
});

module.exports = {
  app: {
    // Never `true`: a packaged run would look for a compiled sidecar under
    // process.resourcesPath, which does not exist here, and the case under test
    // would become an accident of the harness rather than the thing being set
    // up deliberately by the PATH.
    isPackaged: false,
    whenReady: () => Promise.resolve(),
    on: noop, once: noop, quit: noop, exit: noop, relaunch: noop,
    requestSingleInstanceLock: () => true,
    getPath: (n) => require("path").join(process.env.AGX_PROBE_HOME || "/tmp", "probe-" + n),
    getVersion: () => "0.0.0-probe",
    setLoginItemSettings: noop,
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setAppUserModelId: noop,
    commandLine: { appendSwitch: noop },
  },
  BrowserWindow,
  Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({ popup: noop }) },
  dialog: {
    showMessageBox: () => Promise.resolve({ response: 1 }),
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  },
  ipcMain: { on: noop, handle: noop, removeHandler: noop },
  protocol: { registerSchemesAsPrivileged: noop, handle: noop },
  screen: {
    getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workAreaSize: { width: 1920, height: 1080 } }),
  },
  session: { defaultSession: fakeSession(), fromPartition: fakeSession },
  shell: { openExternal: () => Promise.resolve(), showItemInFolder: noop },
  nativeTheme: { on: noop, shouldUseDarkColors: true },
  clipboard: { writeText: noop, readText: () => "" },
};
