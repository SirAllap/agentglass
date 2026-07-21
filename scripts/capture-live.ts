#!/usr/bin/env bun
/**
 * The few shots the demo build cannot produce, against a throwaway repo.
 *
 * The terminal is disabled in the demo — deliberately, since a public web demo
 * must not hand out a shell — so a demo capture of it is an empty pane, which
 * sells nothing. This runs the real server against a scratch repository in
 * /tmp, with its own config and database directories, so the app has no
 * history, no other projects and nothing of the operator's on screen. The
 * result is a real shell in a real panel that still leaks nothing.
 *
 *   AGX_SHOT_REPO=/tmp/agx-shot-repo bun scripts/capture-live.ts
 */

import { spawn } from "bun";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, ".github", "assets");
const REPO = process.env.AGX_SHOT_REPO || "/tmp/shop-api";
const W = 1440, H = 900, SCALE = 2;

const CHROME = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
function findChrome(): string {
  const pinned = process.env.CHROME_PATH?.trim();
  if (pinned) return pinned;
  for (const c of CHROME) {
    const r = Bun.spawnSync(["which", c]);
    if (r.exitCode === 0) return r.stdout.toString().trim();
  }
  throw new Error("no Chrome found — set CHROME_PATH");
}

async function connect(port: number) {
  let targets: any[] = [];
  for (let i = 0; i < 80; i++) {
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
  await send("Page.enable"); await send("Runtime.enable");
  const ev = async (expr: string) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
  const shot = async () => Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64");
  return { ev, shot, close: () => ws.close() };
}

async function until(cdp: any, expr: string, what: string, ms = 25_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cdp.ev(`!!(${expr})`)) return; await Bun.sleep(150); }
  throw new Error(`timed out waiting for ${what}`);
}

const key = (cdp: any, k: string, mods: Record<string, boolean> = {}) =>
  cdp.ev(`(()=>{window.dispatchEvent(new KeyboardEvent("keydown",Object.assign({key:${JSON.stringify(k)},bubbles:true,cancelable:true},${JSON.stringify(mods)})));return 1})()`);

async function main() {
  if (!existsSync(join(REPO, ".git"))) { console.error(`no scratch repo at ${REPO}`); process.exit(1); }
  if (!existsSync(join(ROOT, "web", "dist", "index.html"))) { console.error("build the web bundle first"); process.exit(1); }

  // Isolated everything: its own config, data and cache, so this run cannot see
  // — or write to — whatever the operator actually has installed.
  const home = mkdtempSync(join(tmpdir(), "agx-shot-home-"));
  const profile = mkdtempSync(join(tmpdir(), "agx-shot-chrome-"));
  const port = 4700 + Math.floor(Math.random() * 100);
  const dport = 9600 + Math.floor(Math.random() * 100);

  const server = spawn({
    cmd: ["bun", join(ROOT, "server", "src", "index.ts")],
    env: {
      ...process.env,
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_ROOT: REPO,
      AGENTGLASS_DB: join(home, "agentglass.db"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      AGENTGLASS_TOKEN: "",
      // A neutral shell for the shot. HOME points at the throwaway directory so
      // no rc file runs and PS1 survives, and the prompt is set explicitly
      // because the default one prints the operator's user and hostname —
      // which would put a real machine's name on a public README.
      HOME: home,
      SHELL: "/bin/bash",
      PS1: "\\[\\e[38;5;114m\\]shop-api\\[\\e[0m\\] $ ",
    },
    stdout: "ignore", stderr: "ignore",
  });

  let chrome: ReturnType<typeof spawn> | null = null;
  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* booting */ }
      await Bun.sleep(250);
    }
    chrome = spawn({
      cmd: [findChrome(), "--headless=new", `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`,
        `--window-size=${W},${H}`, `--force-device-scale-factor=${SCALE}`, "--hide-scrollbars",
        "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox",
        "--force-color-profile=srgb", "--force-prefers-reduced-motion",
        `http://127.0.0.1:${port}/`],
      stdout: "ignore", stderr: "ignore",
    });

    const cdp = await connect(dport);
    await until(cdp, `document.querySelector('#root')?.children.length`, "the app to mount");
    await Bun.sleep(2500);

    await key(cdp, "\\", { ctrlKey: true });
    await until(cdp, `document.querySelector('[role="tablist"][aria-label="Workspace views"]')`, "the workspace");
    await Bun.sleep(1000);

    // The terminal sits wherever the rail puts it; find it by its tooltip
    // rather than assuming a position.
    await cdp.ev(`(()=>{const b=[...document.querySelectorAll('[data-view]')].find(e=>e.dataset.view==='term');b?.click();return 1})()`);
    await Bun.sleep(2500);

    // Something worth reading, typed into the real shell.
    await cdp.ev(`(()=>{const t=document.querySelector('.xterm-helper-textarea');t?.focus();return 1})()`);
    await Bun.sleep(400);
    // Set inside the shell rather than via the environment: an interactive
    // bash sources /etc/bash.bashrc, which assigns PS1 and wins over anything
    // exported. `clear` then removes this line and the distro's first-run
    // banner, so the capture starts on a clean screen.
    const lines = [
      `PS1='\\[\\e[38;5;114m\\]shop-api\\[\\e[0m\\] $ '; clear`,
      "git log --oneline -3",
      "make help",
    ];
    for (const line of lines) {
      await cdp.ev(`(()=>{const t=document.querySelector('.xterm-helper-textarea');
        if(!t) return 0;
        for (const ch of ${JSON.stringify(line + "\r")}) {
          t.dispatchEvent(new InputEvent('input',{data:ch,inputType:'insertText',bubbles:true}));
        }
        return 1})()`);
      await Bun.sleep(1600);
    }
    await Bun.sleep(2000);
    writeFileSync(join(OUT, "terminal.png"), await cdp.shot());
    console.log("  terminal.png");
    cdp.close();
  } finally {
    try { chrome?.kill(); } catch { /* already gone */ }
    try { server.kill(); } catch { /* already gone */ }
    rmSync(profile, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

await main();
