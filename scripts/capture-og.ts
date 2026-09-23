#!/usr/bin/env bun
/**
 * The share card: landing/og.html rendered to landing/og.png.
 *
 * One picture is the og:image, the twitter:image and the repository's social
 * preview. It used to be a frame of the landing hero, and a frame of an app
 * reads as "a screen full of numbers" at the size a chat shows it. The card
 * names the workspace instead — the tools in orbit around the mark, and a
 * headline — so it does not go stale when a panel changes.
 *
 * 1280×640 at 1×: GitHub's social-preview size, 2:1 so X does not crop it,
 * and well under the 1 MB GitHub accepts for a social preview.
 *
 *   bun scripts/capture-og.ts
 */
import { spawn } from "bun";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, findChrome, until } from "./cdp.ts";

const ROOT = resolve(import.meta.dir, "..");
const LANDING = join(ROOT, "landing");
// The web app already depends on this font; the card borrows it. Inter comes
// from Google Fonts (see landing/og.html), so a render needs the network.
const FONTS = join(ROOT, "web", "node_modules", "@fontsource", "jetbrains-mono", "files");
const W = 1280, H = 640, SCALE = 1;

async function main() {
  if (!existsSync(FONTS)) {
    console.error("no web/node_modules — run: cd web && bun install");
    process.exit(1);
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      const file = p.startsWith("/fonts/")
        ? Bun.file(join(FONTS, p.slice("/fonts/".length)))
        : p === "/" ? Bun.file(join(LANDING, "og.html")) : null;
      return file && (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  const profile = mkdtempSync(join(tmpdir(), "agx-og-"));
  const port = 9500 + Math.floor(Math.random() * 200);
  const chrome = spawn({
    cmd: [findChrome(), "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      `--window-size=${W},${H}`, `--force-device-scale-factor=${SCALE}`, "--hide-scrollbars",
      "--no-first-run", "--no-sandbox", "--force-color-profile=srgb", "about:blank"],
    stdout: "ignore", stderr: "ignore",
  });
  try {
    const cdp = await connect(port);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    // A fallback face is close enough to pass a glance and wrong enough
    // to change where the lines break, so wait for the real face.
    await until(cdp, `document.readyState === "complete" && document.fonts.status === "loaded" && document.fonts.check('500 40px "JBM"') && document.fonts.check('700 60px Inter')`, "the card's font", 15_000);
    writeFileSync(join(LANDING, "og.png"), await cdp.shot());
    console.log("  landing/og.png");
    cdp.close();
  } finally {
    try { chrome.kill(); } catch {}
    server.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }
}

await main();
