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
import { copyFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "web", "dist");
const OUT = join(ROOT, ".github", "assets");
const STILLS_ONLY = process.argv.includes("--stills");

/**
 * Wide, and as tall as the content actually is.
 *
 * 1440 was too narrow: the dashboard's grid is responsive, so a narrow viewport
 * stacks it taller than the window and the bottom row — cost, performance,
 * timeline — was sliced off every shot. Widening also fixes the other half of
 * the complaint, that everything looked zoomed in: the same cards across 1920
 * CSS pixels are proportionally smaller than across 1440.
 *
 * The height is not a constant because it cannot be. The dashboard needs
 * whatever it needs (~0.84 of the width at every width tried), so it is
 * measured after load and the viewport is resized to fit. A guessed number
 * would go stale the first time a card is added.
 */
const W = 1920, SCALE = 2;
/** Only until the real height is measured. */
const H_PROBE = 1000;
/** 16:9 for the workspace panels and every GIF frame — they fill their height,
 *  so a taller viewport only adds empty floor beneath them. */
const PANEL_H = 1080;
/** The GIF is emitted at 1× and this width; 2× frames are downscaled into it,
 *  which is what makes text legible at a small file size. */
const GIF_W = 1100, GIF_FPS = 12;
/** How a still goes from a 3840px CDP capture to the asset the README shows —
 *  see scripts/still.ts for why that step exists at all. */
import { finishStill, STILL_W } from "./still.ts";
/** Chrome, the protocol and the static server for the demo build. */
import { connect, findChrome, key, lit, serveDist, until, DEMO_BASE } from "./cdp.ts";

async function main() {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("no demo build — run: cd web && bun run build:demo");
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const server = serveDist(DIST);
  const url = `http://127.0.0.1:${server.port}${DEMO_BASE}/`;
  const profile = mkdtempSync(join(tmpdir(), "agx-capture-"));
  const port = 9400 + Math.floor(Math.random() * 200);

  const chrome = spawn({
    cmd: [findChrome(),
      "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      `--window-size=${W},${H_PROBE}`, `--force-device-scale-factor=${SCALE}`,
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

    // Serious dark for every shot — the house dark is Graphite (SERIOUS_DARK),
    // not the old blue "dark", set before the viewport is probed so nothing is
    // captured mid-repaint. Both keys: the theme id and the mode segment, so
    // however the app resolves the theme on boot it lands on Graphite. (The key
    // is `agentglass-theme`, hyphenated; a dotted `agentglass.theme` reaches
    // nobody, and the mode is `agentglass-theme-mode`.)
    const setTheme = (id: string, mode: string) =>
      cdp.ev(`(()=>{try{localStorage.setItem('agentglass-theme',${lit(id)});localStorage.setItem('agentglass-theme-mode',${lit(mode)});return 1}catch{return 0}})()`);
    await setTheme("graphite", "dark");
    await cdp.ev(`location.reload()`);
    await until(cdp, `document.querySelector('#root')?.children.length`, "the graphite theme");
    await Bun.sleep(2500);

    // Size the viewport to the dashboard rather than cropping the dashboard to
    // the viewport. setDeviceMetricsOverride rather than a window size: the
    // window carries chrome of an unknown height, so asking for 1600 gives an
    // innerHeight of about 1457 and the bottom is clipped again.
    const setViewport = async (h: number) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: h, deviceScaleFactor: SCALE, mobile: false });
      await Bun.sleep(1200);
    };
    // The rail boots on the git view — loadLastView() defaults to it — so the
    // dashboard is selected for its own shot rather than assumed to be up. (The
    // `.aurora` this used to measure is the animated backdrop, present on every
    // view, so the shot was whatever the rail booted into, sized to the backdrop
    // — which is how the dashboard still ended up being the git panel.)
    await cdp.ev(`(()=>{document.querySelector('[data-view="dash"]')?.click();return 1})()`);
    await Bun.sleep(1500);
    // Size the viewport to the dashboard, not the dashboard to the viewport: its
    // content is a scroller, so measure where it starts plus how tall it runs
    // and give it exactly that. A guessed constant clips the bottom row — cost,
    // performance, timeline — the first time a card is added.
    const need = Number(await cdp.ev(`(()=>{const s=[...document.querySelectorAll('.agx-scroll')].filter(e=>e.offsetParent);
      let m=0; for(const e of s){const r=e.getBoundingClientRect(); m=Math.max(m,Math.ceil(r.top+e.scrollHeight));} return m;})()`)) || 1600;
    const TALL = Math.min(2400, need + 24);
    console.log(`dashboard needs ${need}px; panels shot at ${W}x${PANEL_H}`);

    /** Take a still, and optionally hold it in the GIF for `beats` frames.
     *  The GIF keeps the full-resolution frame; only the file on disk shrinks. */
    const capture = async (name: string | null, beats = 0, width = STILL_W) => {
      const png = await cdp.shot();
      if (name) {
        const file = join(OUT, `${name}.png`);
        writeFileSync(file, png);
        finishStill(file, width);
        console.log(`  ${name}.png`);
      }
      for (let i = 0; i < beats; i++) writeFileSync(join(framesDir, `f${String(n++).padStart(4, "0")}.png`), png);
    };

    // Two viewports, because one cannot serve both. The dashboard is a grid
    // simply taller than any sane window — cropping it to 16:9 sliced the cost,
    // performance and timeline row off the bottom of every shot. The workspace
    // panels are the opposite: they fill their height, so giving them the
    // dashboard's 1494px leaves them floating in dead space.
    console.log("stills:");
    await setViewport(TALL);
    await capture("dashboard", 0);

    // Everything else, and every GIF frame, at one consistent 16:9.
    await setViewport(PANEL_H);
    if (!STILLS_ONLY) await capture(null, 14); // the opening dashboard beat

    // The workspace, view by view. Ctrl+\ opens it; Ctrl+1..5 walk the rail in
    // whatever order it is shipped in.
    // No terminal here. It is disabled in the demo — a public demo must not
    // hand out a shell — so capturing it yields an empty pane, and a second and
    // a half of nothing in the middle of the hero GIF. `capture-live.ts` shoots
    // the real one against a throwaway repo instead.
    // Picked by view id, not by Ctrl+<n>. The rail's order is the user's — it
    // is drag-reorderable and persisted — and it gained the pull-request view
    // in the middle, which silently turned Ctrl+3 from Docker into PRs and
    // Ctrl+5 from Chat into the terminal. Two README assets were captured
    // under the wrong name because of it. An id cannot drift.
    const views = ["git", "diff", "pr", "tasks", "files", "docker", "chat"];
    await key(cdp, "\\", { ctrlKey: true });
    await until(cdp, `document.querySelector('[role="tablist"][aria-label="Workspace views"]')`, "the workspace");
    await Bun.sleep(1200);

    for (const id of views) {
      const ok = await cdp.ev(`(()=>{const b=document.querySelector('[data-view=${lit(id)}]');b?.click();return !!b})()`);
      if (!ok) { console.warn(`  ! no "${id}" view in the rail — skipped`); continue; }
      await Bun.sleep(1600);
      // The PR panel opens on Overview; Files is the view worth showing, and
      // it is what the README's caption describes.
      if (id === "pr") {
        await cdp.ev(`(()=>{const b=[...document.querySelectorAll('button')]
          .find(b=>/^Files\\b/.test(b.textContent.trim()));b?.click();return !!b})()`);
        await Bun.sleep(1800);
      }
      // Tasks opens with an empty detail pane ("Pick an issue"); open the first
      // one so the shot shows an issue read, not half a blank column.
      if (id === "tasks") {
        await cdp.ev(`(()=>{const b=[...document.querySelectorAll('button')]
          .find(b=>/Cart total is a cent low/.test(b.textContent||''));b?.click();return !!b})()`);
        await Bun.sleep(1400);
      }
      await capture(id, STILLS_ONLY ? 0 : 16);
    }

    // Ports and Resources are an overlay, not a rail view — opened from the
    // rail's own buttons (aria-labelled) and dismissed with Escape.
    for (const [label, name] of [["Ports", "ports"], ["Resources", "resources"]] as const) {
      const ok = await cdp.ev(`(()=>{const b=document.querySelector('button[aria-label=${lit(label)}]');b?.click();return !!b})()`);
      if (!ok) { console.warn(`  ! no "${label}" button — skipped`); continue; }
      await Bun.sleep(1600);
      await capture(name, STILLS_ONLY ? 0 : 14);
      await key(cdp, "Escape");
      await Bun.sleep(500);
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

    // Themes, on the dashboard so they are comparable. The two serious defaults,
    // side by side: Graphite (Dark) and Porcelain (Light). The filenames stay
    // theme-dark / theme-light — that is what each is, a dark shot and a light
    // one — while the palette is the serious pair, not the old blue and white.
    const themes: [string, string, string][] = [
      ["graphite", "dark", "theme-dark"],
      ["porcelain", "light", "theme-light"],
    ];
    for (const [id, mode, name] of themes) {
      const ok = await setTheme(id, mode);
      if (!ok) continue;
      await cdp.ev(`location.reload()`);
      // Wait for the rail itself, not just #root: the reload restores the last
      // view (not the dashboard), and clicking before the rail has mounted is
      // what left both theme shots on the empty chat pane.
      await until(cdp, `document.querySelector('[data-view="dash"]')`, `the ${id} rail`);
      await Bun.sleep(700);
      // Back to the dashboard for every theme, at its own height, so the Dark
      // and Light shots are the same picture in two palettes.
      await cdp.ev(`(()=>{document.querySelector('[data-view="dash"]')?.click();return 1})()`);
      await Bun.sleep(1800);
      await setViewport(TALL);
      await capture(name, 0, STILL_W);
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
      // The landing page shows the same clip, and its copy had silently gone
      // a release stale — it was still the pre-satellite mark long after the
      // README's was not. Written here rather than left to whoever remembers.
      copyFileSync(join(OUT, "hero.gif"), join(ROOT, "landing", "hero.gif"));
      console.log("  landing/hero.gif");
    }
    rmSync(framesDir, { recursive: true, force: true });
    cleanup();
  }
}

await main();
