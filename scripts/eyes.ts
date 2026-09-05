#!/usr/bin/env bun
/**
 * A run cannot see the app it is asked to redesign — it can only reason about
 * CSS, and reasoning about CSS is how a 359x596 plugin card and a 6px focus
 * ring nobody could see both shipped. This is the fix: build this worktree's
 * own web bundle, serve it from an isolated throwaway server, and drive a
 * headless Chrome over CDP to screenshot it and, more importantly, MEASURE
 * it — a screenshot says something looks wrong, computed geometry says why.
 * A track that resolves to 0x0 (a bare `<span>` ignoring inline width/height)
 * and a card that renders at 359x596 both surfaced from `getBoundingClientRect`
 * + computed style, not from staring at a picture.
 *
 * Isolated so it can never touch the operator's real server: their shell
 * exports AGENTGLASS_TOKEN and AGENTGLASS_BIND=0.0.0.0, and inheriting either
 * makes every request 401 or points this at their real machine. Both are
 * scrubbed, alongside AGENTGLASS_WEB_DIR, which would otherwise serve their
 * installed app instead of the bundle this run just built.
 *
 *   bun scripts/eyes.ts                                   # shot of "/"
 *   bun scripts/eyes.ts --selector '.plugin-card'          # + geometry of it
 *   bun scripts/eyes.ts --path /?token=x --out /tmp/x.png
 *   bun scripts/eyes.ts --no-build                         # reuse web/dist as-is
 *   bun scripts/eyes.ts --do "document.querySelector('[title=Settings]').click()"
 *
 * Prints the screenshot path, then — if --selector matched something — the
 * JSON `getBoundingClientRect()` + a few computed-style properties of the
 * FIRST match, to stdout, so a run can grep the number instead of eyeballing
 * a picture.
 */

import { spawn } from "bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, findChrome, until } from "./cdp.ts";
import { jsLit } from "../shared/jsLit.ts";
import { privateTmuxDir } from "./tmuxTmp.ts";

const ROOT = resolve(import.meta.dir, "..");

const usage = `bun scripts/eyes.ts [--path P] [--selector CSS] [--out FILE] [--width N] [--height N] [--scale N] [--no-build]
                        [--do JS] [--do-file FILE] [--wait MS] [--serve URL]

Screenshot this worktree's own web/dist, served in isolation, and — with
--selector — print the matched element's rendered geometry as JSON.`;

let path = "/";
let selector = "";
let out = join(ROOT, ".agx-eyes.png");
let width = 1440, height = 900, scale = 2;
let build = true;
/* A screen you cannot reach by URL cannot be measured, and the two that most
   needed measuring — settings and the plugins shelf — are both Portals opened
   by a click. --do runs an expression after the app has mounted and before the
   shutter, which is the difference between "this probe covers the front page"
   and "this probe covers the app". */
let doJs = "";
let settle = 1200;
/* Point at a server that is ALREADY running instead of spawning an isolated
   one. The isolated server is the right default — it can never touch the
   operator's data — but it also means every screen is measured against an
   empty database, and "twenty-three identical rows collapse to one" is not a
   claim an empty log can support. With this, the same probe can be run
   against a server someone started on the real database. */
let serveAt = "";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--path") path = argv[++i] ?? path;
  else if (a === "--selector") selector = argv[++i] ?? selector;
  else if (a === "--out") out = resolve(argv[++i] ?? out);
  else if (a === "--width") width = Number(argv[++i]);
  else if (a === "--height") height = Number(argv[++i]);
  else if (a === "--scale") scale = Number(argv[++i]);
  else if (a === "--no-build") build = false;
  else if (a === "--do") doJs = argv[++i] ?? doJs;
  /* A walk over twenty-five pages does not survive a shell argument: a
     backslash in a regex is eaten once by the shell and again by the template
     literal this is spliced into, and the whole expression then fails to parse
     with nothing to show for it but `--do: undefined`. From a file it arrives
     byte for byte. */
  else if (a === "--do-file") doJs = readFileSync(resolve(argv[++i] ?? ""), "utf8");
  else if (a === "--wait") settle = Number(argv[++i]);
  else if (a === "--serve") serveAt = argv[++i] ?? serveAt;
  else if (a === "-h" || a === "--help") { console.log(usage); process.exit(0); }
  else { console.error(`eyes: unknown flag ${a}\n\n${usage}`); process.exit(2); }
}

async function main() {
  if (build) {
    // `bun run build`, NOT `build:demo` — the demo bundle is base-pathed at
    // /agentglass/demo/ and sits on the splash forever when served from the
    // root ("waiting for the server…"). The tell, if this is ever skipped by
    // hand instead: document.body.innerHTML.length around 3,100 instead of
    // the ~50,000 a real mounted app produces.
    console.log("building web/dist …");
    const b = spawn({ cmd: ["bun", "run", "build"], cwd: join(ROOT, "web"), stdout: "inherit", stderr: "inherit" });
    if ((await b.exited) !== 0) { console.error("eyes: web build failed"); process.exit(1); }
  }

  const home = mkdtempSync(join(tmpdir(), "agx-eyes-home-"));
  const profile = mkdtempSync(join(tmpdir(), "agx-eyes-chrome-"));
  const port = 4800 + Math.floor(Math.random() * 200);
  const dport = 9700 + Math.floor(Math.random() * 200);

  const server = serveAt ? null : spawn({
    cmd: ["bun", join(ROOT, "server", "src", "index.ts")],
    env: {
      ...process.env,
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_DB: join(home, "agentglass.db"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      // The engine's generated tmux.conf lives under the STATE dir, not the
      // config dir — isolating only the latter is what once let a throwaway
      // run rewrite the conf the operator's real engine was running on.
      AGENTGLASS_STATE_DIR: join(home, "state"),
      // Its own tmux socket directory: a server with no TMUX_TMPDIR sweeps
      // and lists /tmp/tmux-<uid> — the sessions the operator is working in.
      TMUX_TMPDIR: privateTmuxDir(home),
      // Pin back everything the operator's real shell exports, so this is
      // always loopback, always tokenless, and always serving the bundle
      // this run just built — never their installed app.
      AGENTGLASS_BIND: "127.0.0.1",
      AGENTGLASS_TRUST_LAN: "0",
      AGENTGLASS_WEB_DIR: join(ROOT, "web", "dist"),
      AGENTGLASS_TOKEN: "",
      AGENTGLASS_PTY_SIZE_FILE: "",
    },
    stdout: "ignore", stderr: "ignore",
  });

  let chrome: ReturnType<typeof spawn> | null = null;
  try {
    if (!serveAt) {
      for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* booting */ }
        await Bun.sleep(250);
      }
    }
    chrome = spawn({
      cmd: [findChrome(), "--headless=new", `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`,
        `--window-size=${width},${height}`, `--force-device-scale-factor=${scale}`, "--hide-scrollbars",
        "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox",
        "--force-color-profile=srgb", "--force-prefers-reduced-motion",
        serveAt ? `${serveAt.replace(/\/+$/, "")}${path}` : `http://127.0.0.1:${port}${path}`],
      stdout: "ignore", stderr: "ignore",
    });

    const cdp = await connect(dport);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
    await until(cdp, `document.querySelector('#root')?.children.length`, "the app to mount", 25_000);
    await Bun.sleep(1200); // one settle beat for layout/fonts, not a substitute for the wait above

    if (doJs) {
      /* Reported, not swallowed. A --do that silently failed to find its
         button produces a screenshot of the front page that looks exactly
         like a screenshot of a feature that did not change. */
      /* AWAITED. The first version wrapped the expression in `String(...)`
         inside a synchronous IIFE, so an async --do — a walk over every
         settings page, which is the one this was written for — came back as
         the literal text "[object Promise]" and the shutter fired before the
         walk had started. Runtime.evaluate is already called with
         awaitPromise, but a promise wrapped in a non-promise is not one. */
      const did = await cdp.ev(`(async () => { try { return { ok: true, value: String(await (${doJs})) }; }
        catch (e) { return { ok: false, value: String(e && e.message || e) }; } })()`);
      console.log(`--do: ${JSON.stringify(did)}`);
      if (did && (did as { ok?: boolean }).ok === false) { console.error("eyes: --do threw; the shot below is NOT what you asked for"); }
      await Bun.sleep(settle);
    }

    writeFileSync(out, await cdp.shot());
    console.log(`screenshot: ${out}`);

    if (selector) {
      const geometry = await cdp.ev(`(()=>{
        const el = document.querySelector(${jsLit(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          display: cs.display, position: cs.position, overflow: cs.overflow,
          boxSizing: cs.boxSizing };
      })()`);
      if (geometry === null) console.log(`selector matched nothing: ${selector}`);
      else console.log(JSON.stringify(geometry, null, 2));
    }
    cdp.close();
  } finally {
    // Kill by the PID holding these ports — never pgrep by port or name, and
    // never anything tmux-related: this spawned no session of its own.
    try { chrome?.kill(); } catch { /* already gone */ }
    /* Never kill a server this run did not start. */
    try { server?.kill(); } catch { /* already gone */ }
    rmSync(profile, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

await main();
