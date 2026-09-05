#!/usr/bin/env bun
/**
 * Drive the browser view without launching Electron, and fail if it lies.
 *
 * The view only draws itself inside the desktop shell — it asks `HAS_BROWSER`
 * first, because a `<webview>` does not exist in a plain tab. So the shell's
 * bridge is stubbed before the app's script runs, and everything except the
 * guest itself renders: the tab strip, the toolbar, the menu, the empty state.
 * Which is exactly what was being complained about.
 *
 * This deliberately does NOT start a second Electron beside the one that may
 * already be running on :4000.
 *
 *   bun scripts/browser-drive.ts            # exits non-zero on failure
 *   bun scripts/browser-drive.ts --shots /tmp/x   # and leaves the pictures
 */
import { spawn } from "bun";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, findChrome, until } from "./cdp.ts";
import { privateTmuxDir } from "./tmuxTmp.ts";

const ROOT = resolve(import.meta.dir, "..");
const i = Bun.argv.indexOf("--shots");
const OUT = i > 0 ? Bun.argv[i + 1] ?? null : null;
if (OUT) mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (name: string, ok: boolean, saw?: unknown) => {
  if (ok) { console.log(`  \u2713 ${name}`); return; }
  failures++;
  console.log(`  \u2717 ${name}${saw === undefined ? "" : `  \u2014 saw ${JSON.stringify(saw)}`}`);
};

const home = mkdtempSync(join(tmpdir(), "agx-br-home-"));
const profile = mkdtempSync(join(tmpdir(), "agx-br-chrome-"));
const REPO = join(home, "proj");
mkdirSync(REPO, { recursive: true });
Bun.spawnSync(["git", "init", "-q", REPO]);
Bun.spawnSync(["git", "-C", REPO, "config", "user.email", "p@e.com"]);
Bun.spawnSync(["git", "-C", REPO, "config", "user.name", "P"]);
await Bun.write(join(REPO, "README.md"), "# proj\n");
Bun.spawnSync(["git", "-C", REPO, "add", "-A"]);
Bun.spawnSync(["git", "-C", REPO, "-c", "commit.gpgsign=false", "commit", "-qm", "first"]);

const port = 5300 + Math.floor(Math.random() * 150);
const dport = 10_300 + Math.floor(Math.random() * 150);
const server = spawn({
  cmd: ["bun", join(ROOT, "server", "src", "index.ts")],
  env: {
    ...process.env,
    AGENTGLASS_PORT: String(port), AGENTGLASS_ROOT: REPO,
    AGENTGLASS_WEB_DIR: join(ROOT, "web", "dist"),
    AGENTGLASS_DB: join(home, "agentglass.db"),
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
    // The engine's generated tmux.conf lives in the STATE dir: isolate it too,
    // or a throwaway run rewrites the conf the real engine is running on.
    AGENTGLASS_STATE_DIR: join(home, "state"),
    // Its own tmux socket directory, beside the config/data/cache above and
    // for the same reason: this child is a SERVER, and a server with no
    // TMUX_TMPDIR sweeps and lists /tmp/tmux-<uid> — the sessions the user is
    // working in. See scripts/tmuxTmp.ts for what was measured reaching them.
    TMUX_TMPDIR: privateTmuxDir(home),
    AGENTGLASS_TOKEN: "shot-token", HOME: home, SHELL: "/bin/bash",
  },
  stdout: "ignore", stderr: "ignore",
});

/** What the preload would have put there. Enough for the view to draw. */
const STUB = `
  window.agentglass = window.agentglass || {
    // desktop:true is what bridge() checks first. Without it every other key
    // here is ignored and the rail drops the Browser entry entirely.
    desktop: true,
    platform: "linux",
    browser: true,
    browserPartition: "persist:agentglass-browser",
    onBrowserZoom: () => () => {},
    onBrowserOpenTab: () => () => {},
    setActiveBrowserGuest: () => Promise.resolve(true),
    captureBrowser: () => Promise.resolve(null),
  };
`;

let chrome: ReturnType<typeof spawn> | null = null;
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health?token=shot-token`)).ok) break; } catch { /* booting */ }
    await Bun.sleep(250);
  }
  chrome = spawn({
    cmd: [findChrome(), "--headless=new", `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`,
      "--window-size=1500,940", "--force-device-scale-factor=2", "--hide-scrollbars",
      "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox",
      "--force-color-profile=srgb", "--force-prefers-reduced-motion", "about:blank"],
    stdout: "ignore", stderr: "ignore",
  });
  const cdp = await connect(dport);
  // Before the app's own script, so HAS_BROWSER is true at module load.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/?token=shot-token` });
  await until(cdp, `document.querySelector('#root')?.children.length`, "the app to mount", 30_000);
  await Bun.sleep(2500);

  const shot = async (n: string) => { if (OUT) writeFileSync(join(OUT, `${n}.png`), await cdp.shot()); };
  const click = (re: string) => cdp.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>${re}.test((e.getAttribute('aria-label')||'')+' '+(e.title||'')+' '+e.textContent));if(!b)return false;b.click();return true})()`);

  check("the rail offers the browser", await cdp.ev(
    `(()=>{const b=document.querySelector('button[aria-label="Browser"]');if(!b)return false;b.click();return true})()`));
  await Bun.sleep(1800);
  await shot("01-empty");

  const seen = JSON.parse(String(await cdp.ev(`(()=>{const t=document.body.innerText;return JSON.stringify({
    addressBar: !!document.getElementById('agx-browser-url'),
    tools: [...document.querySelectorAll('button[aria-label]')].map(b=>b.getAttribute('aria-label'))
      .filter(l=>/^(Back|Forward|Reload|Home|New tab|More|Developer tools)$|Find on this page|own browser|Point at an element|Draw on the page/.test(l)),
  })})()`)));
  check("there is an address bar", seen.addressBar);
  for (const want of ["Back", "Forward", "Reload", "Home", "New tab", "Developer tools", "More"]) {
    check(`the toolbar has ${want}`, seen.tools.includes(want), seen.tools);
  }
  check("and the three agent tools", seen.tools.filter((l: string) => /Point at an element|Draw on the page/.test(l)).length === 3, seen.tools);

  check("a second tab opens", await click("/New tab/"));
  await Bun.sleep(700);
  await shot("02-two-tabs");
  check("and there are two of them", await cdp.ev(`document.querySelectorAll('button[aria-label^="Close "]').length`) === 2);

  check("the menu opens", await click("/More/"));
  await Bun.sleep(500);
  await shot("03-menu");
  const menu = JSON.parse(String(await cdp.ev(`(()=>{const t=document.body.innerText;return JSON.stringify({
    phone:/Phone/.test(t), laptop:/Laptop/.test(t), dupe:/Duplicate this tab/.test(t), settings:/Import logins from a browser/.test(t)})})()`)));
  check("with the viewport widths", menu.phone && menu.laptop, menu);
  check("and the login importer, where you need it", menu.settings, menu);

  await cdp.ev(`document.body.click()`);
  await Bun.sleep(300);
  check("find opens", await click("/Find on this page/"));
  await Bun.sleep(500);
  await shot("04-find");

  check("the drawing layer opens", await click("/Draw on the page/"));
  await Bun.sleep(700);
  await shot("05-draw");
  const draw = JSON.parse(String(await cdp.ev(`(()=>{const t=document.body.innerText;return JSON.stringify({
    hand:/Hand it to Claude/.test(t), copy:/Copy it/.test(t),
    tools:[...document.querySelectorAll('button[title]')].map(b=>b.title).filter(x=>/freehand|Arrow|Box|Circle|Undo|Redo|Clear/.test(x)).length})})()`)));
  check("with its tools, and both ways to hand it over", draw.tools === 7 && draw.hand && draw.copy, draw);
  await cdp.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==="Done");b&&b.click();return 1})()`);
  await Bun.sleep(400);

  /*
   * The one that matters most, and the one that was actually reported.
   *
   * `visibility` is INHERITED. The workspace hides a view by setting
   * `visibility: hidden` on it, so a tab that declares `visibility: visible`
   * overrides that and the page stays painted on top of whatever you switched
   * to — every view, not just the terminal. The active tab must therefore
   * declare nothing at all and be free to inherit.
   */
  check("switching away leaves the browser", await cdp.ev(
    `(()=>{const b=document.querySelector('button[aria-label="Git"]');if(!b)return false;b.click();return true})()`));
  await Bun.sleep(1500);
  await shot("06-switched-away");
  /* EVERY guest, not the first one: there are two tabs by now and the first is
     legitimately hidden whatever the view is doing, so asking only about that
     one would pass for the wrong reason. */
  const vis = async () => JSON.parse(String(await cdp.ev(
    `JSON.stringify([...document.querySelectorAll('webview')].map(w=>getComputedStyle(w).visibility))`))) as string[];
  const away = await vis();
  check("every page is really hidden, not merely behind", away.length > 0 && away.every((v) => v === "hidden"), away);

  check("and it comes back when you return", await cdp.ev(
    `(()=>{const b=document.querySelector('button[aria-label="Browser"]');if(!b)return false;b.click();return true})()`));
  await Bun.sleep(1200);
  const back = await vis();
  check("exactly the tab you were on is visible again",
    back.filter((v) => v === "visible").length === 1, back);
  await shot("07-back");

  cdp.close();
} finally {
  try { chrome?.kill(); } catch { /* gone */ }
  try { server.kill(); } catch { /* gone */ }
  rmSync(profile, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
