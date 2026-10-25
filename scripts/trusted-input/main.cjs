/* The Electron half of scripts/trusted-input.ts: a window that is never
   shown, the shell's real input module, and a DevTools relay for the focus
   emulation the verbs ask for. */
const { app, BrowserWindow, ipcMain, webContents } = require("electron");
const path = require("path");
const { sendInput, isAgentInput } = require("../../electron/trusted-input.js");

const dir = process.argv.find((a) => a.startsWith("--dir="))?.slice(6);
const off = process.argv.includes("--off");

ipcMain.handle("input", (_e, req) => {
  const guest = webContents.fromId(Number(req.guestId));
  return guest ? sendInput(guest, req) : { ok: false, error: "no such guest" };
});
ipcMain.handle("cdp", async (_e, { gid, method, params }) => {
  const guest = webContents.fromId(Number(gid));
  if (!guest) return { ok: false, error: "no such guest" };
  if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
  try { return { ok: true, result: await guest.debugger.sendCommand(method, params) }; } catch (err) { return { ok: false, error: String(err) }; }
});
/* The shell's guest key handler forwards Ctrl+W, Ctrl+T, Escape… to the app.
   This one stands in for it: a key it sees without the agent mark is a key
   the app would have acted on. Proves the mark is held while the handler runs. */
const chords = { marked: [], forwarded: [] };
app.on("web-contents-created", (_e, wc) => {
  if (wc.getType() !== "webview") return;
  wc.on("before-input-event", (_ev, input) => {
    if (input.type !== "keyDown" || !(input.control || input.meta)) return;
    (isAgentInput(wc) ? chords.marked : chords.forwarded).push(input.key.toLowerCase());
  });
});
ipcMain.handle("chords", () => chords);
ipcMain.on("line", (_e, l) => process.stdout.write(l + "\n"));
ipcMain.on("done", () => app.exit(0));

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600,
    webPreferences: { webviewTag: true, contextIsolation: false, nodeIntegration: true } });
  win.loadFile(path.join(dir, "host.html"), off ? { search: "off=1" } : {});
  setTimeout(() => { process.stdout.write(JSON.stringify({ name: "harness", ok: false, error: "timed out" }) + "\n"); app.exit(2); }, 60_000);
});
