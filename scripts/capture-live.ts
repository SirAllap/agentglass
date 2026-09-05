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
/** Same finishing as the demo stills, so the terminal shot sits beside them in
 *  the README at the same width, density and weight. */
import { finishStill } from "./still.ts";
import { privateTmuxDir } from "./tmuxTmp.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, ".github", "assets");
const REPO = process.env.AGX_SHOT_REPO || "/tmp/shop-api";
// Matches capture.ts, so the terminal shot sits beside the others in the README
// at the same width and density rather than looking zoomed in next to them.
const W = 1920, SCALE = 2;
const H_PROBE = 1000;
const PANEL_H = 1080;

/** Chrome and the protocol — the same helpers capture.ts and make-icons.ts
 *  drive, so a fix to the connect retry loop reaches all three.
 *  (capture-phone.ts was the fourth; it photographed the browser companion for
 *  the README and went when that did — mobile/scripts/qa.ts shoots the app.) */
import { connect, findChrome, key, until } from "./cdp.ts";
import { jsLit } from "../shared/jsLit.ts";

async function main() {
  if (!existsSync(join(REPO, ".git"))) { console.error(`no scratch repo at ${REPO}`); process.exit(1); }
  if (!existsSync(join(ROOT, "web", "dist", "index.html"))) { console.error("build the web bundle first"); process.exit(1); }

  // Isolated everything: its own config, data and cache, so this run cannot see
  // — or write to — whatever the operator actually has installed.
  const home = mkdtempSync(join(tmpdir(), "agx-shot-home-"));
  // Pre-seed the scope so the app boots straight into the scratch repo. Without
  // a persisted `root` a desktop launch has no "current folder" and opens the
  // first-run "Open a project" picker over everything — which then sits over
  // the shot no matter what is dismissed after.
  mkdirSync(join(home, "config", "agentglass"), { recursive: true });
  writeFileSync(join(home, "config", "agentglass", "config.json"), JSON.stringify({ root: REPO }));
  const profile = mkdtempSync(join(tmpdir(), "agx-shot-chrome-"));
  const port = 4700 + Math.floor(Math.random() * 100);
  const dport = 9600 + Math.floor(Math.random() * 100);

  const server = spawn({
    cmd: ["bun", join(ROOT, "server", "src", "index.ts")],
    env: {
      ...process.env,
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_ROOT: REPO,
      // discoverRepos no longer sweeps the disk — it reads telemetry and the
      // configured repo dirs. This throwaway HOME has no session history, so
      // without this the repo picker is empty ("No repos seen yet") and the
      // terminal never gets a shell. Point it straight at the scratch repo.
      AGENTGLASS_REPO_DIRS: REPO,
      AGENTGLASS_DB: join(home, "agentglass.db"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      /* And the STATE dir, which is where the engine's generated tmux.conf
         lives. Isolating the config alone is what let a throwaway run rewrite
         the conf the operator's own engine is running on — measured twice on a
         real machine, and the reason confPath() now names itself after the
         config dir. Belt and braces: this run should not even share the file
         name. */
      AGENTGLASS_STATE_DIR: join(home, "state"),
      // Its own tmux socket directory, beside the config/data/cache above and
      // for the same reason: this child is a SERVER, and a server with no
      // TMUX_TMPDIR sweeps and lists /tmp/tmux-<uid> — the sessions the user is
      // working in. See scripts/tmuxTmp.ts for what was measured reaching them.
      TMUX_TMPDIR: privateTmuxDir(home),
      // The operator's own shell exports leak in through ...process.env, and on
      // a machine already running agentglass they are hostile to a headless
      // shot: AGENTGLASS_BIND=0.0.0.0 + TRUST_LAN mint a token the tokenless
      // capture page cannot present (so every API 401s and the repo picker is
      // empty), and AGENTGLASS_WEB_DIR points at the installed app rather than
      // the bundle this run just built. Pin them back to a loopback, no-auth,
      // serve-the-fresh-build server.
      AGENTGLASS_BIND: "127.0.0.1",
      AGENTGLASS_TRUST_LAN: "0",
      AGENTGLASS_WEB_DIR: join(ROOT, "web", "dist"),
      AGENTGLASS_PTY_SIZE_FILE: "",
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
        `--window-size=${W},${H_PROBE}`, `--force-device-scale-factor=${SCALE}`, "--hide-scrollbars",
        "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox",
        "--force-color-profile=srgb", "--force-prefers-reduced-motion",
        `http://127.0.0.1:${port}/`],
      stdout: "ignore", stderr: "ignore",
    });

    const cdp = await connect(dport);
    // Injected to run at document-start on the reloaded page, before the app
    // reads any of them — so they are in place a tick early rather than a tick
    // late (setItem-then-reload left the first-run picker sitting over the shot):
    //   - Graphite (SERIOUS_DARK), so the terminal matches the other shots.
    //   - agentglass.projectChosen, so the first-run "Open a project" picker,
    //     which keys off that flag, never opens over the terminal.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try{localStorage.setItem('agentglass-theme','graphite');localStorage.setItem('agentglass-theme-mode','dark');localStorage.setItem('agentglass.projectChosen','1');}catch(e){}`,
    });
    await cdp.send("Page.reload");
    await until(cdp, `document.querySelector('#root')?.children.length`, "the graphite terminal", 25_000);
    await Bun.sleep(2500);
    // 16:9, matching the other workspace panels in capture.ts — the terminal
    // fills its height, so the dashboard's taller viewport would only add floor.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: PANEL_H, deviceScaleFactor: SCALE, mobile: false });
    await Bun.sleep(1200);

    await key(cdp, "\\", { ctrlKey: true });
    await until(cdp, `document.querySelector('[role="tablist"][aria-label="Workspace views"]')`, "the workspace", 25_000);
    await Bun.sleep(1000);

    // The terminal sits wherever the rail puts it; find it by its tooltip
    // rather than assuming a position.
    await cdp.ev(`(()=>{const b=[...document.querySelectorAll('[data-view]')].find(e=>e.dataset.view==='term');b?.click();return 1})()`);
    await Bun.sleep(2500);

    // The live build discovers repos from session history, and this throwaway
    // HOME has none — so the terminal opens on "Pick a repo" rather than a shell.
    // Open the picker and choose the scratch repo; only then does the PTY start
    // and there is a `.xterm-helper-textarea` to type into.
    await cdp.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/Pick a repo/.test(b.textContent||''));b?.click();return !!b})()`);
    // The picker fetches on open and the first git call spawns subprocesses, so
    // wait for the row to actually appear rather than guessing a delay — clicking
    // before it loads was what left the picker on "No repos seen yet".
    await until(cdp, `[...document.querySelectorAll('button')].some(b=>/shop-api/.test(b.textContent||''))`, "the scratch repo in the picker", 15_000);
    await cdp.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/shop-api/.test(b.textContent||''));b?.click();return !!b})()`);
    // The PTY opens and the login shell draws its first prompt.
    await until(cdp, `document.querySelector('.xterm-helper-textarea')`, "the shell", 15_000);
    await Bun.sleep(2000);

    // Close the first-run "Open a project" picker BEFORE typing. Left open it
    // steals the keyboard: the PS1 that hides the operator's user@host never
    // reaches the shell, and the raw prompt — a real hostname — lands in the
    // shot. Click its scrim (the backdrop, whose onClick is the dismiss), with
    // Escape as a fallback, then let focus settle back on the terminal.
    await cdp.ev(`(()=>{const s=document.querySelector('.agx-scrim');s&&s.click();return !!s})()`);
    await key(cdp, "Escape");
    await Bun.sleep(700);

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
        for (const ch of ${jsLit(line + "\r")}) {
          t.dispatchEvent(new InputEvent('input',{data:ch,inputType:'insertText',bubbles:true}));
        }
        return 1})()`);
      await Bun.sleep(1600);
    }
    await Bun.sleep(2000);
    // Safety net: if the picker is somehow up again, close it on its scrim
    // before the shutter (it was already dismissed before typing).
    await cdp.ev(`(()=>{const s=document.querySelector('.agx-scrim');s&&s.click();return !!s})()`);
    await Bun.sleep(500);
    const file = join(OUT, "terminal.png");
    writeFileSync(file, await cdp.shot());
    finishStill(file);
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
