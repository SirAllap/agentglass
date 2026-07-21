#!/usr/bin/env bun
/**
 * Screenshots and the hero GIF for the README, from the demo build.
 *
 * The demo build and nothing else, deliberately. A real workspace has the
 * user's repository names, their branch tickets, their spend and their session
 * titles on screen, and this README is public — capturing a live app would put
 * whatever happened to be open that afternoon on the front page of the project,
 * permanently. `VITE_DEMO=1` renders the same UI over fabricated data, so what
 * ships is the design rather than somebody's Tuesday.
 *
 * Driven over CDP for the same reason the smoke test is: `Page.captureScreenshot`
 * returns exactly what compositing produced, and every step can wait for a real
 * condition instead of a guessed sleep.
 *
 *   bun scripts/capture.ts            # stills + hero.gif into .github/assets
 *   bun scripts/capture.ts --stills   # skip the GIF (much faster)
 */

import { spawn } from "bun";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "web", "dist");
const OUT = join(ROOT, ".github", "assets");
const STILLS_ONLY = process.argv.includes("--stills");

/** 16:10 at 2× — sharp on a retina README without being a 4K download. */
const W = 1440, H = 900, SCALE = 2;
/** The GIF is emitted at 1× and this width; 2× frames are downscaled into it,
 *  which is what makes text legible at a small file size. */
const GIF_W = 1100, GIF_FPS = 12;

/** The demo build is based at /agentglass/demo/ so it can be served from
 *  GitHub Pages, so its asset URLs carry that prefix. Serving it at the root
 *  gives a page whose scripts all 404 and a #root that never fills. */
const BASE = "/agentglass/demo";

function serveDist() {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      let path = new URL(req.url).pathname;
      if (path.startsWith(BASE)) path = path.slice(BASE.length) || "/";
      const file = Bun.file(join(DIST, path === "/" ? "index.html" : path));
      if (await file.exists()) return new Response(file);
      if (!path.split("/").pop()!.includes("."))
        return new Response(Bun.file(join(DIST, "index.html")), { headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404 });
    },
  });
}

const CHROME = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "/usr/bin/google-chrome"];
function findChrome(): string {
  const pinned = process.env.CHROME_PATH?.trim();
  if (pinned) return pinned;
  for (const c of CHROME) {
    const r = Bun.spawnSync(["which", c]);
    if (r.exitCode === 0) return r.stdout.toString().trim();
  }
  throw new Error("no Chrome found — set CHROME_PATH");
}

type CDP = {
  send: (m: string, p?: unknown) => Promise<any>;
  ev: (expr: string) => Promise<any>;
  shot: () => Promise<Buffer>;
  close: () => void;
};

async function connect(port: number): Promise<CDP> {
  let targets: any[] = [];
  for (let i = 0; i < 60; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.length) break; }
    catch { /* not up yet */ }
    await Bun.sleep(250);
  }
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map<number, (v: any) => void>();
  await new Promise((r) => ws.addEventListener("open", r as any));
  ws.addEventListener("message", (e: any) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m.error); pending.delete(m.id); }
  });
  const send = (method: string, params: unknown = {}) =>
    new Promise<any>((res) => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Runtime.enable");
  const ev = async (expr: string) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
  const shot = async () => Buffer.from((await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64");
  return { send, ev, shot, close: () => ws.close() };
}

/** Wait for a condition rather than a guessed delay — a fixed sleep either
 *  wastes seconds or captures a half-painted frame, and which one depends on
 *  the machine. */
async function until(cdp: CDP, expr: string, what: string, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cdp.ev(`!!(${expr})`)) return;
    await Bun.sleep(120);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const key = (cdp: CDP, k: string, mods: Record<string, boolean> = {}) =>
  cdp.ev(`(()=>{window.dispatchEvent(new KeyboardEvent("keydown",Object.assign({key:${JSON.stringify(k)},bubbles:true,cancelable:true},${JSON.stringify(mods)})));return 1})()`);

async function main() {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("no demo build — run: cd web && bun run build:demo");
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const server = serveDist();
  const url = `http://127.0.0.1:${server.port}${BASE}/`;
  const profile = mkdtempSync(join(tmpdir(), "agx-capture-"));
  const port = 9400 + Math.floor(Math.random() * 200);

  const chrome = spawn({
    cmd: [findChrome(),
      "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      `--window-size=${W},${H}`, `--force-device-scale-factor=${SCALE}`,
      "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
      "--disable-gpu", "--no-sandbox", "--force-color-profile=srgb",
      // Deterministic frames: without this the GIF picks up whatever the
      // animations happened to be doing when the shutter opened.
      "--force-prefers-reduced-motion",
      url],
    stdout: "ignore", stderr: "ignore",
  });

  const frames: Buffer[] = [];
  const framesDir = mkdtempSync(join(tmpdir(), "agx-frames-"));
  let n = 0;
  const cleanup = () => { try { chrome.kill(); } catch {} server.stop(true); rmSync(profile, { recursive: true, force: true }); };

  try {
    const cdp = await connect(port);
    await until(cdp, `document.querySelector('#root')?.children.length`, "the app to mount");
    await Bun.sleep(2500); // let the demo stream seed a few events

    /** Take a still, and optionally hold it in the GIF for `beats` frames. */
    const capture = async (name: string | null, beats = 0) => {
      const png = await cdp.shot();
      if (name) { writeFileSync(join(OUT, `${name}.png`), png); console.log(`  ${name}.png`); }
      for (let i = 0; i < beats; i++) writeFileSync(join(framesDir, `f${String(n++).padStart(4, "0")}.png`), png);
    };

    console.log("stills:");
    await capture("dashboard", STILLS_ONLY ? 0 : 14);

    // The workspace, view by view. Ctrl+\ opens it; Ctrl+1..5 walk the rail in
    // whatever order it is shipped in.
    // No terminal here. It is disabled in the demo — a public demo must not
    // hand out a shell — so capturing it yields an empty pane, and a second and
    // a half of nothing in the middle of the hero GIF. `capture-live.ts` shoots
    // the real one against a throwaway repo instead.
    const views: [string, string][] = [["git", "1"], ["diff", "2"], ["docker", "3"], ["chat", "5"]];
    await key(cdp, "\\", { ctrlKey: true });
    await until(cdp, `document.querySelector('[role="tablist"][aria-label="Workspace views"]')`, "the workspace");
    await Bun.sleep(1200);

    for (const [name, k] of views) {
      await key(cdp, k, { ctrlKey: true });
      await Bun.sleep(1400);
      await capture(name, STILLS_ONLY ? 0 : 16);
    }

    // Settings, which is where today's shortcuts and About live.
    await key(cdp, "Escape");
    await Bun.sleep(700);
    await cdp.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/settings/i.test(b.getAttribute('title')||b.getAttribute('aria-label')||''));b?.click();return 1})()`);
    await Bun.sleep(1100);
    await capture("settings", 0);
    await cdp.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Shortcuts');b?.click();return 1})()`);
    await Bun.sleep(700);
    await capture("settings-shortcuts", 0);
    await key(cdp, "Escape");
    await Bun.sleep(600);

    // Themes, each on the dashboard so they are comparable.
    const themes = ["forest", "ember", "deep-sea", "light"];
    for (const t of themes) {
      const ok = await cdp.ev(`(()=>{try{localStorage.setItem('agentglass.theme',${JSON.stringify(t)});window.dispatchEvent(new StorageEvent('storage',{key:'agentglass.theme'}));return 1}catch{return 0}})()`);
      if (!ok) continue;
      await cdp.ev(`location.reload()`);
      await until(cdp, `document.querySelector('#root')?.children.length`, `the ${t} theme`);
      await Bun.sleep(2200);
      await capture(`theme-${t}`, 0);
    }

    cdp.close();
  } finally {
    if (!STILLS_ONLY && n > 0) {
      console.log(`\ngif: ${n} frames → hero.gif`);
      // Two passes: a palette built from the whole clip, then applied with
      // dithering. One-pass GIF encoding picks 256 colours per frame and the
      // result banks and shimmers — which is most of why the old one looked bad.
      const pal = join(framesDir, "palette.png");
      const run = (args: string[]) => Bun.spawnSync(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", ...args]);
      run(["-framerate", String(GIF_FPS), "-i", join(framesDir, "f%04d.png"),
        "-vf", `scale=${GIF_W}:-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=192`, pal]);
      run(["-framerate", String(GIF_FPS), "-i", join(framesDir, "f%04d.png"), "-i", pal,
        "-lavfi", `scale=${GIF_W}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
        "-loop", "0", join(OUT, "hero.gif")]);
    }
    rmSync(framesDir, { recursive: true, force: true });
    cleanup();
  }
}

await main();
