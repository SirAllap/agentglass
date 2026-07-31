#!/usr/bin/env bun
/**
 * Render the phone's icons from the marks in the repository.
 *
 * Everything the companion offered a phone was an SVG, and the three places a
 * phone actually reads an icon from are the three that handle SVG worst:
 * `apple-touch-icon` (iOS ignores it and screenshots the page instead, so the
 * home-screen icon was a shrunken dashboard), the manifest's install and splash
 * path, and a notification's `icon`/`badge`. All three want rasters.
 *
 * They are generated rather than drawn, and the generator is checked in beside
 * them, because the alternative is five binaries nobody can regenerate when the
 * mark changes. Chromium does the rendering — it is already a dependency of the
 * phone audit, and it rasterises the same SVG the browser would.
 *
 *   bun scripts/make-icons.ts        # rewrites web/public/*.png
 *
 * Re-run it whenever web/public/icon-app.svg, icon-maskable.svg or
 * icon-badge.svg change. web/test/phone-icons.test.ts fails if a PNG a phone
 * needs is missing or is not actually a PNG.
 */
import { spawn } from "bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, findChrome } from "./cdp.ts";

const PUBLIC = new URL("../web/public/", import.meta.url).pathname;

/** source SVG → output PNG at this many device pixels square. */
const WANTED: { from: string; to: string; size: number; why: string }[] = [
  { from: "icon-app.svg", to: "apple-touch-icon.png", size: 180,
    why: "iOS home screen. 180 is the largest size it asks for, and it downscales." },
  { from: "icon-app.svg", to: "icon-192.png", size: 192,
    why: "The manifest's `any` icon: Android's install prompt and task switcher." },
  { from: "icon-app.svg", to: "icon-512.png", size: 512,
    why: "The manifest's `any` icon at splash-screen size." },
  { from: "icon-maskable.svg", to: "icon-maskable-512.png", size: 512,
    why: "`maskable`: the mark sits inside the safe circle so a launcher can crop it to any shape." },
  { from: "icon-badge.svg", to: "icon-badge.png", size: 96,
    why: "The status-bar badge. Drawn from the alpha channel alone, so it is a white stencil." },
];

const chromePort = 9351;
const profile = mkdtempSync(join(tmpdir(), "agx-icons-"));
const chrome = spawn([
  findChrome(),
  `--remote-debugging-port=${chromePort}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--hide-scrollbars",
  "--no-first-run",
  ...(process.getuid?.() === 0 ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
  "about:blank",
], { stdout: "ignore", stderr: "ignore" });

const cdp = await connect(chromePort);
try {
  for (const { from, to, size, why } of WANTED) {
    const svg = readFileSync(join(PUBLIC, from), "utf8");
    // The SVG inline in a full-bleed page rather than as an <img>: an <img>
    // would be laid out and could land on a half-pixel, and these are icons —
    // one soft edge at 96px is visible on a status bar.
    const page = `<!doctype html><meta charset="utf-8">` +
      `<style>html,body{margin:0;padding:0;background:transparent}` +
      `svg{display:block;width:${size}px;height:${size}px}</style>` + svg;
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: size, height: size, deviceScaleFactor: 1, mobile: false,
    });
    // Without this the page composites onto opaque white, and the badge — whose
    // whole job is to be a shape cut out of nothing — comes back as a white
    // square with a slightly whiter mark on it.
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    await cdp.send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(page) });
    await Bun.sleep(220);
    const png = await cdp.shot();
    writeFileSync(join(PUBLIC, to), png);
    console.log(`  ${to.padEnd(26)} ${String(size).padStart(3)}px  ${(png.length / 1024).toFixed(1)} kB  ← ${from}`);
    console.log(`  ${" ".repeat(26)}      ${why}`);
  }
} finally {
  cdp.close();
  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
}
