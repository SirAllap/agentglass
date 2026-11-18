/**
 * The window under agent load, for scripts/loadagents.ts (AGX_LOAD_WINDOW=1).
 *
 * loadagents.ts times the server and the relay with a bare WebSocket, which
 * never draws anything. Smoothness is felt in the window, where every byte of
 * every terminal goes through xterm on one renderer thread. This opens the
 * built bundle (web/dist, served by the isolated server through
 * AGENTGLASS_WEB_DIR) in headless Chrome, opens terminals the way a person
 * does (the project as a workspace, the Terminal view, "New shell" in the plus
 * menu once per desk), starts a printer in each, and during the measure window records in the page:
 *   - long tasks (PerformanceObserver "longtask"): count, total, max;
 *   - frame gaps (requestAnimationFrame deltas): p50/p99/max, over 50 and 250 ms;
 *   - JS heap (performance.memory, in MB);
 *   - a keystroke typed into the focused terminal until its echo is in the
 *     xterm DOM rows: the user's own path, p50/p99.
 * Echo can only be read from the DOM renderer (canvas and WebGL draw pixels),
 * so the page runs it by default (AGX_LOAD_WINDOW_RENDERER=dom). With
 * =canvas or =auto the frames and long tasks are the real renderer's and the
 * echo list is empty (reported as such, never as zero).
 *
 * AGX_LOAD_WINDOW_ELECTRON=1 swaps headless Chrome for the REAL Electron shell
 * (electron/main.js on the same bundle): the binary is run by its real path, not
 * the .bin wrapper, because Hyprland window rules match by PID. The shell finds
 * the isolated load server with no change to main.js: AGENTGLASS_PORT names the
 * port, pickPort() probes it, and a development shell adopts a tokenless server
 * that says it is agentglass (the load server is both). Its config, data and
 * cache live under the run's temp dir, and AGENTGLASS_DEBUG_PORT (the one door
 * main.js has for CDP) opens the debugging port. On Hyprland it is placed on a
 * silent workspace through hyprctl; a workspace nobody looks at may give the
 * page no frames at all, so the result says how many frames came and whether
 * the page was visible (frames.n = 0 means "not drawn", never "smooth").
 *
 * Which desks are open is reported as picked/asked. When a step fails the page
 * is dumped (screenshot, visible text, steps tried) to AGX_LOAD_WINDOW_DEBUG,
 * default .agx-tmp/lw-fail.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, findChrome, key, until, type CDP } from "./cdp.ts";
import { jsLit } from "../shared/jsLit.ts";

const pct = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((q / 100) * a.length))] ?? 0;
};

export type WindowOpts = {
  url: string;
  /** The project (a repo root) opened as a workspace. */
  project: string;
  /** How many shells to have live in it. The last one stays focused and quiet (the typed one). */
  desks: number;
  /** How many of the printing desks flood instead of printing at a steady rate. */
  flood: number;
  renderer: "dom" | "canvas" | "auto";
  /** Measure the real Electron window instead of headless Chrome. */
  electron?: boolean;
};

export type WindowResult = {
  desks: { asked: number; picked: number; flooding: number };
  renderer: string;
  long_tasks: { n: number; total_ms: number; max_ms: number };
  frames: { n: number; p50: number; p99: number; max: number; over_50ms: number; over_250ms: number };
  heap_mb: { start: number; end: number; max: number } | null;
  echo: { n: number; p50: number; p95: number; p99: number; max: number; timeouts_5s: number; readable: boolean };
  /** What was measured: headless Chrome or the real Electron shell. */
  target?: "chrome" | "electron";
  /** document.visibilityState at the start and end of the measure window (Electron only). */
  visibility?: { start: string; end: string };
  /** Set when the frame numbers cannot be read as smoothness (no frames, or a hidden page). */
  frames_note?: string;
  error?: string;
};

/** The main checkout of the repo this worktree belongs to (the worktree itself when it is the main one). */
function mainCheckout(root: string): string {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  const common = r.status === 0 ? r.stdout.trim() : "";
  return common.endsWith("/.git") ? common.slice(0, -5) : root;
}

/** The Electron binary: ELECTRON_PATH, else the newest under node_modules/.bun (the real file, not the .bin wrapper) or electron/node_modules, in this tree and then in the main checkout's. */
export function findElectron(root: string): string {
  const pinned = process.env.ELECTRON_PATH?.trim();
  if (pinned) return pinned;
  for (const base of [root, mainCheckout(root)]) {
    const store = join(base, "node_modules", ".bun");
    const dirs = existsSync(store) ? readdirSync(store).filter((d) => d.startsWith("electron@")).sort() : [];
    for (const d of dirs.reverse()) {
      const bin = join(store, d, "node_modules", "electron", "dist", "electron");
      if (existsSync(bin)) return bin;
    }
    const own = join(base, "electron", "node_modules", "electron", "dist", "electron");
    if (existsSync(own)) return own;
  }
  throw new Error("no electron binary under node_modules/.bun/electron@* or electron/node_modules (here or in the main checkout): run bun install, or set ELECTRON_PATH");
}

/** Single-quote a value for sh. */
export const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * The person's variables the shell needs to open a window and find its tools, and nothing else: API keys and tokens in
 * their shell never reach run.sh (it is a file on disk). AGENTGLASS_* and ELECTRON_* of their own are dropped; the launcher
 * passes its own in `own`, which always wins.
 */
const SHELL_KEEP = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LANGUAGE", "TZ", "HYPRLAND_INSTANCE_SIGNATURE", "GDK_BACKEND", "XCURSOR_THEME", "XCURSOR_SIZE"]);
export function shellEnv(from: Record<string, string | undefined>, own: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) if (v !== undefined && (SHELL_KEEP.has(k) || k.startsWith("XDG_") || k.startsWith("LC_"))) env[k] = v;
  return Object.assign(env, own);
}

/** run.sh: export `env`, record its own PID, exec the binary (so the PID is Electron's). */
export const runScript = (env: Record<string, string>, pidFile: string, bin: string, args: string[]) =>
  `#!/bin/sh\n${Object.entries(env).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => `export ${k}=${shq(v)}`).join("\n")}\necho $$ > ${shq(pidFile)}\nexec ${shq(bin)} ${args.map(shq).join(" ")}\n`;

/**
 * Start the real Electron shell on a server already running at `url`. A run.sh in `profile` sets the environment, records
 * its own PID and execs the binary, so the PID is the Electron main process on both launch paths. On Hyprland the shell is
 * started by the compositor (hl.exec_cmd) so the window rule sees a normal client: workspace 5, silent, floating, no focus.
 * Anywhere else it is spawned directly. `dir` is the electron home inside `profile` (XDG_* and --user-data-dir live there).
 */
export async function launchElectronShell(o: { root: string; url: string; dport: number; profile: string; step?: (s: string) => void }): Promise<{ pid: number; child: ReturnType<typeof spawn> | null }> {
  const { root, url, dport, profile } = o;
  const step = o.step ?? (() => {});
  const bin = findElectron(root);
  const home = join(profile, "electron");
  for (const d of ["config", "data", "cache", "user-data"]) mkdirSync(join(home, d), { recursive: true });
  const env = shellEnv(process.env, {
    AGENTGLASS_PORT: new URL(url).port, // pickPort() probes this port first and adopts the server that answers: no new env switch in main.js
    AGENTGLASS_DEBUG_PORT: String(dport), // main.js turns this into --remote-debugging-port (it never reads that off argv)
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
  });
  const pidFile = join(profile, "electron.pid");
  try { rmSync(pidFile, { force: true }); } catch { /* a run before this one */ }
  const script = join(profile, "run.sh");
  const args = [join(root, "electron"), "--no-sandbox", `--user-data-dir=${join(home, "user-data")}`, "--enable-precise-memory-info"];
  writeFileSync(script, runScript(env, pidFile, bin, args), { mode: 0o700 });

  let child: ReturnType<typeof spawn> | null = null;
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    const lua = `hl.exec_cmd("sh ${script.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}", { workspace = "5 silent", float = true, size = "1440 900", no_initial_focus = true })`;
    step(`hyprctl eval ${lua}`);
    const r = spawnSync("hyprctl", ["eval", lua], { encoding: "utf8", timeout: 10_000 });
    if (r.status !== 0) throw new Error(`hyprctl eval failed: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
  } else {
    step(`spawn electron directly (no Hyprland): sh ${script}`);
    child = spawn("sh", [script], { stdio: "ignore" });
  }
  let pid = 0;
  for (let i = 0; i < 100 && !pid; i++) {
    try { pid = Number(readFileSync(pidFile, "utf8").trim()) || 0; } catch { /* not written yet */ }
    if (!pid) await Bun.sleep(100);
  }
  // The script has done its job once the PID is written (it exec'd Electron); it is not left on disk. The pid file stays.
  // Kept when no PID was written: run.sh is what explains why Electron did not start.
  if (pid) { try { rmSync(script, { force: true }); } catch { /* already gone */ } }
  else throw new Error(`electron never started (no PID written; script kept at ${script})`);
  step(`electron pid ${pid}, debug port ${dport}, server ${url}`);
  return { pid, child };
}

/** A free loopback port: bind 0, read it, let go. */
function freePort(): number {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = l.port;
  l.stop(true);
  return p;
}

/** The steady printer is the pane agents' own (500 bytes, ten times a second); the flood is `yes`. */
const steady = (i: number) =>
  `s=$(printf 'desk${i}-%.0s' {1..70}); while :; do printf '%s\\n' "$s"; sleep 0.1; done`;
const floodCmd = (i: number) => `yes desk${i}-flood`;

const evJson = async (cdp: CDP, expr: string) => cdp.ev(expr);

/** Type text into the focused xterm the way a keyboard does: one input event per character. */
const typeInto = (cdp: CDP, text: string) =>
  cdp.ev(`(()=>{const t=document.querySelector('.xterm-helper-textarea:focus')||document.querySelector('.xterm-helper-textarea');
    if(!t) return 0; t.focus();
    for (const ch of ${jsLit(text)}) t.dispatchEvent(new InputEvent('input',{data:ch,inputType:'insertText',bubbles:true}));
    return 1})()`);

export class LoadWindow {
  private chrome: ReturnType<typeof spawn> | null = null;
  /** The Electron main process, killed by PID and never by a pattern. */
  private electronPid = 0;
  private visStart = "";
  private profile = "";
  private cdp: CDP | null = null;
  private picked = 0;
  private flooding = 0;
  private stopped = false;
  private echo: number[] = [];
  private echoTimeouts = 0;
  private echoLoop: Promise<void> | null = null;
  private readable = false;

  constructor(private o: WindowOpts) {}

  /** What was tried and what was seen, for the failure dump. */
  private tried: string[] = [];
  private step(what: string) { this.tried.push(what); }

  /** Save what the page looked like when a step failed: screenshot, visible text, the steps tried. */
  private async dump(why: string): Promise<string> {
    const dir = resolve(process.env.AGX_LOAD_WINDOW_DEBUG || join(import.meta.dir, "..", ".agx-tmp", "lw-fail"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "tried.txt"), `failed: ${why}\n\n${this.tried.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n`);
      const cdp = this.cdp;
      if (cdp) {
        try { writeFileSync(join(dir, "page.png"), await cdp.shot()); } catch (e) { writeFileSync(join(dir, "page.png.err"), String(e)); }
        try {
          const seen = await cdp.ev(`JSON.stringify({url:location.href,view:document.querySelector('[role="tab"][aria-selected="true"][data-view]')?.dataset.view||null,
            views:[...document.querySelectorAll('[data-view]')].map(e=>e.dataset.view),
            buttons:[...document.querySelectorAll('button')].slice(0,80).map(b=>(b.getAttribute('aria-label')||b.title||b.textContent||'').trim().slice(0,60)),
            xterm:document.querySelectorAll('.xterm').length,text:(document.body.innerText||'').slice(0,6000)})`);
          writeFileSync(join(dir, "page.json"), String(seen));
        } catch (e) { writeFileSync(join(dir, "page.json.err"), String(e)); }
      }
    } catch { /* the dump must never hide the real error */ }
    return dir;
  }

  /**
   * Open Chrome on the window and get `desks` live terminals in the open project, the way a person does:
   * the project is a workspace (POST /workspace, what the project picker does; there is no repo picker in the
   * Terminal view any more, a new shell opens in the open project), then Terminal view, then "New shell" in the
   * plus menu once per desk. Throws with the step that failed and a dump of the page (AGX_LOAD_WINDOW_DEBUG).
   */
  async open(): Promise<void> {
    try { await this.openSteps(); }
    catch (e) {
      const dir = await this.dump(e instanceof Error ? e.message : String(e));
      throw new Error(`${e instanceof Error ? e.message : e} (page dump in ${dir})`);
    }
  }

  private async openSteps(): Promise<void> {
    const { url, project, renderer } = this.o;
    this.step(`POST ${url}/workspace {roots:[${project}]}`);
    const ws = await fetch(`${url}/workspace`, { method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify({ roots: [project] }), signal: AbortSignal.timeout(10_000) })
      .then((r) => r.json() as Promise<{ ok?: boolean; error?: string }>).catch((e) => ({ ok: false, error: String(e) }));
    if (!ws.ok) throw new Error(`could not open the project as a workspace: ${ws.error ?? "refused"}`);
    this.profile = mkdtempSync(join(tmpdir(), "agx-load-window-"));
    let dport = 9300 + Math.floor(Math.random() * 400);
    if (this.o.electron) {
      dport = freePort();
      await this.launchElectron(url, dport);
    } else {
      this.step(`chrome headless on debug port ${dport}, renderer ${renderer}`);
      this.chrome = spawn(findChrome(), ["--headless=new", `--remote-debugging-port=${dport}`, `--user-data-dir=${this.profile}`,
        "--window-size=1600,900", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox",
        "--force-prefers-reduced-motion", "--enable-precise-memory-info", url], { stdio: "ignore" });
    }
    this.step(`connect CDP on ${dport}${this.o.electron ? " (target agentglass://app)" : ""}`);
    const cdp = (this.cdp = await connect(dport, 120, this.o.electron ? (t) => t.type === "page" && String(t.url).startsWith("agentglass://app") : undefined));
    // At document start, before the app reads them: the startup question answered, and the renderer.
    const pref = renderer === "dom" ? "dom" : renderer === "canvas" ? "canvas" : "";
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try{localStorage.setItem('agentglass.projectChosen','1');${pref ? `localStorage.setItem('agentglass.term.webgl',${jsLit(pref)});` : ""}}catch(e){}`,
    });
    await cdp.send("Page.reload");
    this.step("wait: #root filled and the launch cover gone");
    await until(cdp, `document.querySelector('#root')?.children.length && !document.documentElement.classList.contains('ag-covering')`, "the window to draw", 30_000);
    await Bun.sleep(1500);
    // The app may start on the dashboard; the workspace (rail with views) comes with Ctrl+\ there.
    this.step("wait: rail [role=tablist][aria-label='Workspace views'] (Ctrl+\\ if absent)");
    if (!(await cdp.ev(`!!document.querySelector('[role="tablist"][aria-label="Workspace views"]')`))) await key(cdp, "\\", { ctrlKey: true });
    await until(cdp, `document.querySelector('[role="tablist"][aria-label="Workspace views"]')`, "the workspace rail", 25_000);
    this.step("click: [data-view=term]");
    await until(cdp, `document.querySelector('[data-view="term"]')`, "the Terminal view button", 10_000);
    await cdp.ev(`(()=>{document.querySelector('[data-view="term"]')?.click();return 1})()`);
    this.step("wait: .xterm-helper-textarea (the first shell in the open project)");
    // The Electron shell restores an empty desk instead of opening a first shell,
    // so after a short wait the + opens one, the way a person would.
    try { await until(cdp, `document.querySelector('.xterm-helper-textarea')`, "the first shell", 6_000); }
    catch {
      this.step("no first shell: empty-desk tile, then + > New shell (fallback Ctrl+Shift+T)");
      // An empty desk shows a "New shell" tile and may have no strip, so no + button: try the tile first.
      // Ctrl+Shift+T answers only while a strip is on screen.
      const clickShell = `(()=>{const r=[...document.querySelectorAll('[role="menuitem"],button')].filter(e=>(e.textContent||'').trim().startsWith('New shell')&&e.children.length<4).pop();r?.click();return !!r})()`;
      let clicked = await cdp.ev(clickShell);
      if (!clicked) {
        const menu = await cdp.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/^New window/.test(b.getAttribute('aria-label')||b.title||''));b?.click();return !!b})()`);
        if (menu) { await Bun.sleep(300); clicked = await cdp.ev(clickShell); }
      }
      if (!clicked) await key(cdp, "T", { ctrlKey: true, shiftKey: true });
      await until(cdp, `document.querySelector('.xterm-helper-textarea')`, "the first shell", 30_000);
    }
    await Bun.sleep(1500);
    this.picked = 1;

    for (let i = 0; i < this.o.desks; i++) {
      // A printer runs in the shell that is on screen, then a new shell opens (the printing one keeps running off screen).
      // The last desk stays quiet: it is the one typed into.
      if (i > 0 || this.o.desks > 1) {
        if (i < this.o.desks - 1) {
          const loud = i < this.o.flood;
          if (loud) this.flooding++;
          this.step(`type printer (${loud ? "flood" : "steady"}) into desk ${i + 1}`);
          await typeInto(cdp, `${loud ? floodCmd(i) : steady(i)}\r`);
          await Bun.sleep(600);
        }
      }
      if (i === this.o.desks - 1) break;
      this.step(`new shell ${i + 2}: plus menu "New window" > "New shell"`);
      const before = await cdp.ev(`document.querySelectorAll('.xterm-helper-textarea').length`);
      const menu = await cdp.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/^New window/.test(b.getAttribute('aria-label')||b.title||''));b?.click();return !!b})()`);
      let clicked = false;
      if (menu) {
        await Bun.sleep(300);
        clicked = await cdp.ev(`(()=>{const r=[...document.querySelectorAll('[role="menuitem"],button,div')].filter(e=>(e.textContent||'').trim().startsWith('New shell')&&e.children.length<4).pop();r?.click();return !!r})()`);
      }
      if (!clicked) {
        this.step("fallback: chord Ctrl+Shift+T (terminal.newshell)");
        await key(cdp, "T", { ctrlKey: true, shiftKey: true });
      }
      try { await until(cdp, `document.querySelector('.xterm-helper-textarea')`, `shell ${i + 2}`, 20_000); } catch { break; }
      await Bun.sleep(1200);
      this.picked++;
    }
    await cdp.ev(`(()=>{document.querySelector('.xterm-helper-textarea')?.focus();return 1})()`);
    this.readable = await cdp.ev(`!!document.querySelector('.xterm-rows')`);
  }

  /** Start the real Electron shell on the load server (see launchElectronShell). */
  private async launchElectron(url: string, dport: number): Promise<void> {
    const r = await launchElectronShell({ root: resolve(import.meta.dir, ".."), url, dport, profile: this.profile, step: (x) => this.step(x) });
    this.electronPid = r.pid;
    this.chrome = r.child;
  }

  /** Start recording in the page. Called at the start of the measure window. */
  async begin(): Promise<void> {
    const cdp = this.cdp!;
    await cdp.ev(`(()=>{
      const w = window.__agxLoad = { lt: [], gaps: [], heap: [], stop: false };
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.lt.push(e.duration); }).observe({ entryTypes: ["longtask"] }); } catch (e) {}
      let last = performance.now();
      const tick = (t) => { w.gaps.push(t - last); last = t; if (!w.stop) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const mem = () => performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
      w.heap.push(mem());
      w.mem = mem;
      return document.visibilityState})()`).then((v: unknown) => { this.visStart = String(v); });
    this.echoLoop = this.typeLoop();
  }

  /** One keystroke every 200 ms into the focused terminal; the time until its echo is in the DOM rows. */
  private async typeLoop(): Promise<void> {
    const cdp = this.cdp!;
    let k = 0;
    while (!this.stopped) {
      const a = performance.now();
      // A token the shell has not printed before, so an old echo cannot answer it.
      const tok = String.fromCharCode(97 + (k % 26)) + String(k).padStart(4, "0");
      k++;
      const ok = await cdp.ev(`(()=>{const t=document.querySelector('.xterm-helper-textarea');if(!t) return 0;t.focus();
        for (const ch of ${jsLit(tok)}) t.dispatchEvent(new InputEvent('input',{data:ch,inputType:'insertText',bubbles:true}));return 1})()`).catch(() => 0);
      if (ok && this.readable) {
        const seen = await cdp.ev(`new Promise((res)=>{const t0=performance.now();const chk=()=>{
          const rows=[...document.querySelectorAll('.xterm-rows')].map(r=>r.textContent||'').join('\\n');
          if(rows.includes(${jsLit(tok)})) return res(performance.now()-t0);
          if(performance.now()-t0>5000) return res(-1);
          requestAnimationFrame(chk)};chk()})`).catch(() => -1);
        if (typeof seen === "number" && seen >= 0) this.echo.push(seen);
        else if (typeof seen === "number") this.echoTimeouts++;
      }
      // Wipe the line now and then so the prompt never runs off the screen.
      if (k % 20 === 0) await cdp.ev(`(()=>{const t=document.querySelector('.xterm-helper-textarea');t?.dispatchEvent(new InputEvent('input',{data:'\\x15',inputType:'insertText',bubbles:true}));return 1})()`).catch(() => 0);
      await new Promise<void>((r) => setTimeout(r, Math.max(1, 200 - (performance.now() - a))));
    }
  }

  /** Stop recording and read what the page saw. */
  async end(): Promise<WindowResult> {
    const cdp = this.cdp!;
    this.stopped = true;
    await Promise.race([this.echoLoop, Bun.sleep(7000)]);
    const raw = (await evJson(cdp, `(()=>{const w=window.__agxLoad;if(!w) return null;w.stop=true;const m=w.mem?w.mem():null;
      return {lt:w.lt,gaps:w.gaps.slice(1),heap:[w.heap[0],m],vis:document.visibilityState}})()`).catch(() => null)) as { lt: number[]; gaps: number[]; heap: (number | null)[]; vis?: string } | null;
    const r: WindowResult = {
      desks: { asked: this.o.desks, picked: this.picked, flooding: this.flooding },
      renderer: this.o.renderer,
      target: this.o.electron ? "electron" : "chrome",
      long_tasks: { n: 0, total_ms: 0, max_ms: 0 },
      frames: { n: 0, p50: 0, p99: 0, max: 0, over_50ms: 0, over_250ms: 0 },
      heap_mb: null,
      echo: { n: this.echo.length, p50: pct(this.echo, 50), p95: pct(this.echo, 95), p99: pct(this.echo, 99), max: this.echo.length ? Math.max(...this.echo) : 0, timeouts_5s: this.echoTimeouts, readable: this.readable },
    };
    if (!raw) return { ...r, error: "the page recorded nothing (it reloaded or the probe was lost)" };
    const { lt, gaps, heap } = raw;
    r.long_tasks = { n: lt.length, total_ms: Math.round(lt.reduce((a, b) => a + b, 0)), max_ms: Math.round(lt.length ? Math.max(...lt) : 0) };
    r.frames = { n: gaps.length, p50: pct(gaps, 50), p99: pct(gaps, 99), max: gaps.length ? Math.max(...gaps) : 0,
      over_50ms: gaps.filter((g) => g > 50).length, over_250ms: gaps.filter((g) => g > 250).length };
    if (this.o.electron) {
      r.visibility = { start: this.visStart, end: raw.vis ?? "?" };
      if (gaps.length === 0) r.frames_note = "NO frames arrived (rAF never fired): the window was not drawn, so frame gaps say nothing about smoothness";
      else if (r.visibility.start !== "visible" || r.visibility.end !== "visible") r.frames_note = `page was ${r.visibility.start}/${r.visibility.end}: Chromium throttles frames in a hidden page, read the gaps with that in mind`;
    }
    if (heap[0] != null && heap[1] != null) r.heap_mb = { start: Math.round(heap[0]), end: Math.round(heap[1]), max: Math.round(Math.max(heap[0], heap[1])) };
    return r;
  }

  close(): void {
    this.stopped = true;
    try { this.cdp?.close(); } catch { /* gone */ }
    try { this.chrome?.kill("SIGKILL"); } catch { /* gone */ }
    // By PID only, never a pattern: the PID in electron.pid is the Electron main process (run.sh execs it).
    if (this.electronPid) try { process.kill(this.electronPid, "SIGKILL"); } catch { /* gone */ }
    if (this.profile) try { rmSync(this.profile, { recursive: true, force: true }); } catch { /* next run's problem */ }
  }
}
