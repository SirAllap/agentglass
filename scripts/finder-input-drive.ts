#!/usr/bin/env bun
/**
 * The finder's input, pressed for real: one case per surface, each a mouse
 * button or a key sent through the browser's own input pipeline (CDP
 * Input.dispatch*), never a synthetic dispatchEvent, against an isolated
 * server and the production bundle.
 *
 * The decisions are unit-tested in web/test/finder-pointer.test.ts and
 * finder-keys.test.ts. What only a browser can show is whether the handler the
 * decision lives in is the one the event reaches: a click that bubbles to a row
 * and to the empty space, a contextmenu after a mousedown, a dblclick after two
 * clicks. Each case below names the Strata behaviour it holds the finder to.
 *
 *   bun run build && bun scripts/finder-input-drive.ts            # exits non-zero on failure
 *   bun scripts/finder-input-drive.ts --shots /tmp/x                # and leaves the pictures
 */
import { spawn } from "bun";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, findChrome, until, type CDP } from "./cdp.ts";
import { privateTmuxDir } from "./tmuxTmp.ts";
import { jsLit } from "../shared/jsLit.ts";

const ROOT = resolve(import.meta.dir, "..");
const i = Bun.argv.indexOf("--shots");
const OUT = i > 0 ? Bun.argv[i + 1] ?? null : null;
if (OUT) mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (name: string, ok: boolean, saw?: unknown) => {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.log(`  ✗ ${name}${saw === undefined ? "" : `  — saw ${JSON.stringify(saw)}`}`);
};

// A folder with sub-folders and files, the shape every case starts from.
const home = mkdtempSync(join(tmpdir(), "agx-fin-home-"));
const profile = mkdtempSync(join(tmpdir(), "agx-fin-chrome-"));
const DEMO = join(home, "orbit");
for (const d of ["alpha", "beta", "gamma/inner"]) mkdirSync(join(DEMO, d), { recursive: true });
for (const f of ["notes.md", "report-1.txt", "report-2.txt", "report-3.txt"]) writeFileSync(join(DEMO, f), `${f}\n`);
writeFileSync(join(DEMO, "beta", "plan.txt"), "plan\n");

const port = 5450 + Math.floor(Math.random() * 150);
const dport = 10_450 + Math.floor(Math.random() * 150);
const server = spawn({
  cmd: ["bun", join(ROOT, "server", "src", "index.ts")],
  env: {
    ...process.env,
    AGENTGLASS_PORT: String(port), AGENTGLASS_ROOT: home,
    AGENTGLASS_WEB_DIR: join(ROOT, "web", "dist"),
    AGENTGLASS_DB: join(home, "agentglass.db"),
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
    AGENTGLASS_STATE_DIR: join(home, "state"),
    TMUX_TMPDIR: privateTmuxDir(home),
    AGENTGLASS_TOKEN: "drive-token", HOME: home, SHELL: "/bin/bash",
  },
  stdout: "ignore", stderr: "ignore",
});

const MODS = (m = "") => (m.includes("alt") ? 1 : 0) | (m.includes("ctrl") ? 2 : 0) | (m.includes("shift") ? 8 : 0);
const VK: Record<string, number> = { Enter: 13, Escape: 27, Backspace: 8, " ": 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PageUp: 33, PageDown: 34, F10: 121, ContextMenu: 93 };

let chrome: ReturnType<typeof spawn> | null = null;
try {
  for (let n = 0; n < 80; n++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health?token=drive-token`)).ok) break; } catch { /* booting */ }
    await Bun.sleep(250);
  }
  chrome = spawn({
    cmd: [findChrome(), "--headless=new", `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`,
      "--window-size=1400,900", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox",
      "--force-prefers-reduced-motion", "about:blank"],
    stdout: "ignore", stderr: "ignore",
  });
  const cdp: CDP = await connect(dport);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  const mouse = async (x: number, y: number, button: string, count = 1, m = "") => {
    const modifiers = MODS(m);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
    for (let c = 1; c <= count; c++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: c, modifiers });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: c, modifiers });
    }
    await Bun.sleep(450);
  };
  const on = async (expr: string, button = "left", count = 1, m = "") => {
    const p = await cdp.ev(`(()=>{const e=(${expr});if(!e)return null;e.scrollIntoView?.({block:"nearest"});const r=e.getBoundingClientRect();return [r.left+Math.min(r.width/2,30),r.top+r.height/2]})()`);
    if (!p) throw new Error(`nothing to press: ${expr}`);
    await mouse(p[0], p[1], button, count, m);
  };
  const key = async (k: string, m = "") => {
    const modifiers = MODS(m);
    const vk = VK[k] ?? k.toUpperCase().charCodeAt(0);
    const code = k === " " ? "Space" : VK[k] ? k : /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^[0-9]$/.test(k) ? `Digit${k}` : k === "/" ? "Slash" : k === "=" ? "Equal" : k;
    const text = k.length === 1 && !(modifiers & 3) ? k : undefined;
    await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers, text });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await Bun.sleep(350);
  };
  const row = (n: string) => `[...document.querySelectorAll("[data-machine-finder] [data-row]")].filter(e=>e.dataset.row===${jsLit(n)}).pop()`;
  type State = { path: string; dirs: string[]; sel: string[]; menus: string[]; tabs: number; view: string; fields: string[] };
  const state = async (): Promise<State> => JSON.parse(String(await cdp.ev(`(()=>{const f=document.querySelector("[data-machine-finder]");if(!f)return JSON.stringify({path:"closed",dirs:[],sel:[],menus:[],tabs:0,view:"",fields:[]});
    return JSON.stringify({path:f.querySelector('[role=navigation][aria-label=Path]')?.textContent.replace(/\\s+/g,"")??"",
      dirs:[...f.querySelectorAll("[data-dir]")].map(s=>s.dataset.dir.split("/").pop()),
      sel:[...f.querySelectorAll("[aria-selected=true]")].map(e=>e.dataset.row).filter(Boolean),
      menus:[...document.querySelectorAll("[role=menu]")].map(e=>e.getAttribute("aria-label")),
      tabs:f.querySelectorAll("[role=tab]").length,
      view:JSON.parse(localStorage.getItem("agentglass.finder.machine.prefs")||"{}").view||"columns",
      fields:[...f.querySelectorAll("input")].filter(i=>i.getAttribute("aria-label")!=="Path").map(i=>i.value)})})()`)));
  /** A point in the empty space under the rows of the view showing `dir`. */
  const emptyOf = async (dir: string, button = "left") => {
    const p = await cdp.ev(`(()=>{const e=[...document.querySelectorAll("[data-machine-finder] [data-dir]")].find(d=>d.dataset.dir.endsWith("/"+${jsLit(dir)}));const r=e.getBoundingClientRect();return [r.left+r.width/2,r.bottom-24]})()`);
    await mouse(p[0], p[1], button);
  };
  const shot = async (n: string) => { if (OUT) writeFileSync(join(OUT, `${n}.png`), await cdp.shot()); };

  /** Every case starts from the same place: the finder open on ~/orbit in the given view, nothing selected. */
  const fresh = async (view: "columns" | "icons" | "list") => {
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/?token=drive-token` });
    await until(cdp, `document.querySelector('#root')?.children.length`, "the app to mount", 30_000);
    await cdp.ev(`localStorage.setItem("agentglass.finder.machine.prefs", JSON.stringify({view:${jsLit(view)},preview:false})); localStorage.removeItem("agentglass.finder.machine.state"); 1`);
    await cdp.send("Page.reload");
    await until(cdp, `document.querySelector('button[aria-label^="Finder"], button[title^="Finder"]')`, "the Finder button", 30_000);
    await Bun.sleep(500);
    await cdp.ev(`document.querySelector('[role=dialog] [aria-label=Close]')?.click(); 1`);
    await Bun.sleep(250);
    await cdp.ev(`[...document.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")||b.title||"").startsWith("Finder"))?.click(); 1`);
    await until(cdp, `document.querySelector("[data-machine-finder] [data-row]")`, "the finder", 15_000);
    await key("l", "ctrl");
    await cdp.ev(`(()=>{const i=document.querySelector('[data-machine-finder] input[aria-label=Path]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,"~/orbit");i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
    await key("Enter");
    try { await until(cdp, row("report-1.txt"), "~/orbit listed", 15_000); } catch (e) { await shot("fresh-failed"); console.log(JSON.stringify(await state()), await cdp.ev(`document.activeElement?.outerHTML.slice(0,200)`)); throw e; }
    await Bun.sleep(300);
  };

  console.log("Columns, Icons and List rows (Strata: the right button never opens; Icons and List open on two clicks)");
  await fresh("columns");
  await on(row("gamma"), "right");
  let s = await state();
  check("Columns: right click on a folder selects it and opens its menu, and no column opens", s.sel.includes("gamma") && s.menus.length === 1 && !s.dirs.includes("gamma"), s);
  await shot("columns-right");
  await key("Escape");
  await on(row("beta"));
  await emptyOf("orbit");
  s = await state();
  check("Columns: a click on the empty space below the rows clears the selection and closes the column to its right", s.sel.length === 0 && !s.dirs.includes("beta"), s);
  await fresh("icons");
  await on(row("beta"));
  s = await state();
  check("Icons: one click on a folder only selects it", s.sel.includes("beta") && s.path.endsWith("orbit"), s);
  await on(row("beta"), "left", 2);
  s = await state();
  check("Icons: two clicks enter it", s.path.endsWith("orbit/beta"), s);
  await fresh("list");
  await on(row("gamma"), "middle");
  s = await state();
  check("List: the middle button opens the folder in a new tab", s.tabs === 2 && s.path.endsWith("orbit/gamma"), s);

  console.log("Keys in the views (Strata: a letter is the filter's, Esc takes one thing a press, Space opens a folder)");
  await fresh("columns");
  await on(row("report-1.txt"));
  await key("r");
  s = await state();
  check("Columns: a letter opens the column's filter with that letter in it", s.fields.includes("r"), s);
  await key("Escape");
  s = await state();
  check("Esc in the filter closes it and leaves the selection", s.fields.length === 0 && s.sel.includes("report-1.txt") && s.path !== "closed", s);
  await key("Escape");
  await key("Escape");
  s = await state();
  check("Esc again takes away the preview, then the selection, and the finder stays open", s.sel.length === 0 && s.path !== "closed", s);
  await fresh("icons");
  await on(row("beta"));
  await key(" ");
  s = await state();
  check("Icons: Space on a folder opens it", s.path.endsWith("orbit/beta"), s);
  await fresh("list");
  await on(row("beta"));
  await key("ArrowLeft");
  const inSide = async () => cdp.ev(`!!document.activeElement?.closest("[data-finder-sidebar]")`);
  check("List: Left takes the keyboard to the sidebar and leaves the folder alone", (await inSide()) && (await state()).path.endsWith("orbit"));
  await key("ArrowRight");
  check("Right from the sidebar gives it back to the files", !(await inSide()) && !!(await cdp.ev(`!!document.activeElement?.closest("[data-dir]")`)), await cdp.ev(`document.activeElement?.outerHTML.slice(0,80)`));
  await key("2", "ctrl");
  check("Ctrl+2 is the finder's Icons view, not the app's second view", (await state()).view === "icons");

  console.log("The chrome (Strata: the path bar's right button is the path's menu; no browser menu anywhere)");
  await fresh("columns");
  await on(`[...document.querySelectorAll('[data-machine-finder] [aria-label=Path] button')].find(b=>b.textContent.trim()==="~")`, "right");
  const items = await cdp.ev(`JSON.stringify([...document.querySelectorAll('[role=menu][aria-label="Path hierarchy"] [role=menuitem], [role=menu][aria-label="Path hierarchy"] button')].map(b=>b.textContent.trim()))`);
  check("right button on a crumb opens the hierarchy, current folder first, and does not navigate", items === JSON.stringify(["orbit", "~"]) && (await state()).path.endsWith("orbit"), items);
  await on(`[...document.querySelectorAll('[role=menu][aria-label="Path hierarchy"] button, [role=menu][aria-label="Path hierarchy"] [role=menuitem]')].find(b=>b.textContent.trim()==="~")`);
  s = await state();
  check("a folder in it goes there", s.path === "~" && !(await cdp.ev(`!!document.querySelector('[data-machine-finder] input[aria-label=Path]')`)), s);
  await cdp.ev(`window.__native=[];window.addEventListener("contextmenu",e=>__native.push(e.defaultPrevented),false);1`);
  await on(`document.querySelector('[data-machine-finder] section header b')`, "right");
  check("right button on a column's title: no menu of Strata's and none of the browser's", JSON.parse(String(await cdp.ev(`JSON.stringify(__native)`))).every(Boolean) && (await state()).menus.length === 0);

  console.log("Dragging (Strata: a drag resting on a folder opens it after 750 ms)");
  await fresh("columns");
  // A real drag start (the page's dragstart runs), handed to CDP so the drop side can be driven.
  await cdp.send("Input.setInterceptDrags", { enabled: true });
  const from = await cdp.ev(`(()=>{const r=(${row("report-2.txt")}).getBoundingClientRect();return [r.left+30,r.top+r.height/2]})()`);
  const to = await cdp.ev(`(()=>{const r=(${row("gamma")}).getBoundingClientRect();return [r.left+30,r.top+r.height/2]})()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from[0], y: from[1] });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from[0], y: from[1], button: "left", clickCount: 1, buttons: 1 });
  for (let n = 1; n <= 8; n++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from[0] + 3 * n, y: from[1] + 4 * n, button: "left", buttons: 1 });
  const data = { items: [{ mimeType: "text/plain", data: "report-2.txt" }], dragOperationsMask: 17 };
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x: to[0], y: to[1], data });
  for (let n = 0; n < 9; n++) { await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x: to[0], y: to[1], data }); await Bun.sleep(100); }
  s = await state();
  check("Columns: resting a drag on a folder for 750 ms opens it as the next column", s.dirs.includes("gamma"), s);
  await cdp.send("Input.dispatchDragEvent", { type: "dragCancel", x: to[0], y: to[1], data }).catch(() => undefined);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to[0], y: to[1], button: "left", clickCount: 1 });
  await cdp.send("Input.setInterceptDrags", { enabled: false });

  console.log("Gestures (Strata: rubber band from the empty space, slow click renames, Ctrl+wheel sizes the text)");
  await fresh("list");
  const r1 = await cdp.ev(`(()=>{const r=(${row("report-1.txt")}).getBoundingClientRect();return [r.right-40,r.top+r.height/2]})()`);
  const r3 = await cdp.ev(`(()=>{const r=(${row("report-3.txt")}).getBoundingClientRect();return [r.right-40,r.top+r.height/2]})()`);
  const box = await cdp.ev(`(()=>{const e=[...document.querySelectorAll("[data-machine-finder] [data-dir]")].find(d=>d.dataset.dir.endsWith("/orbit"));const r=e.getBoundingClientRect();return [r.left+r.width/2,r.bottom-20]})()`);
  // From the empty space below the rows, up across report-3 and report-2: Strata selects what the box touches.
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box[0], y: box[1] });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box[0], y: box[1], button: "left", clickCount: 1, buttons: 1 });
  for (let n = 1; n <= 10; n++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box[0] + ((r3[0] - box[0]) * n) / 10, y: box[1] + ((r3[1] - 20 - box[1]) * n) / 10, button: "left", buttons: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r3[0], y: r3[1] - 20, button: "left", clickCount: 1 });
  await Bun.sleep(400);
  s = await state();
  check("List: a drag from the empty space selects the rows its box touches", s.sel.includes("report-3.txt") && s.sel.includes("report-2.txt") && !s.sel.includes("report-1.txt"), s);
  void r1;
  await fresh("columns");
  await on(row("notes.md"));
  await Bun.sleep(700);
  await on(`(${row("notes.md")}).querySelector("[data-name]")`);
  await Bun.sleep(900);
  check("Columns: a second, slow click on the selected row's name renames it", !!(await cdp.ev(`!!document.querySelector('[data-machine-finder] [data-row="notes.md"] input, [data-machine-finder] input[aria-label^="Rename"], [data-machine-finder] input[aria-label*="name"]')`)), await cdp.ev(`[...document.querySelectorAll('[data-machine-finder] input')].map(i=>i.getAttribute('aria-label')).join()`));
  await key("Escape");
  const p0 = await cdp.ev(`(()=>{const r=(${row("beta")}).getBoundingClientRect();return [r.left+30,r.top+5]})()`);
  const before = JSON.parse(String(await cdp.ev(`localStorage.getItem("agentglass.finder.machine.prefs")`))).textSize ?? 13;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p0[0], y: p0[1], deltaX: 0, deltaY: -100, modifiers: 2 });
  await Bun.sleep(300);
  const after = JSON.parse(String(await cdp.ev(`localStorage.getItem("agentglass.finder.machine.prefs")`))).textSize;
  check("Ctrl and the wheel make the finder's text a size bigger", after === before + 1, { before, after });

  console.log("Focus and menus from the keyboard (Strata: the Menu key is the selection's menu; Up from the first row reaches the header)");
  await fresh("columns");
  await on(row("report-2.txt"));
  await key("ContextMenu");
  s = await state();
  const head = await cdp.ev(`document.querySelector('[role=menu]')?.textContent.slice(0,40)`);
  check("the Menu key opens the selected row's menu, not the folder's", s.menus.length === 1 && String(head).includes("report-2.txt"), head);
  await key("Escape");
  check("Esc closes it and the keyboard is back on the files", (await state()).menus.length === 0 && !!(await cdp.ev(`!!document.activeElement?.closest("[data-dir]")`)));
  await on(row("alpha"));
  await key("ArrowUp");
  check("Up on the first row moves the keyboard to the column's header", !!(await cdp.ev(`!!document.activeElement?.closest("[data-dir] header")`)));
  await key("ArrowDown");
  check("Down from the header goes back to the rows", !!(await cdp.ev(`document.activeElement?.getAttribute("role")==="listbox"`)));

} finally {
  try { chrome?.kill(); } catch { /* gone */ }
  try { server.kill(); } catch { /* gone */ }
  rmSync(profile, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
