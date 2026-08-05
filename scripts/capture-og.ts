#!/usr/bin/env bun
/**
 * The Open Graph / Twitter social card, from the landing hero itself.
 *
 * It used to be a bespoke illustration in the old Midnight Purple identity. The
 * hero is the brand image now — the glass over the fleet — and it is Graphite,
 * so the card is a real frame of it rather than a drawing that drifts from the
 * page it sits in front of. 2400×1260 (the 1.91:1 OG ratio at 2×), written
 * straight to landing/og.png.
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
const DIST = join(ROOT, "web", "dist");
// 1200×630 at 2× — the OG card at retina, exactly the dimensions the landing's
// <meta og:image:width/height> already declare.
const W = 1200, H = 630, SCALE = 2;

async function main() {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("no demo build — run: cd web && bun run build:demo");
    process.exit(1);
  }
  // Landing at /agentglass/, demo at /agentglass/demo/ (the glass opens onto it).
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      let p = new URL(req.url).pathname;
      if (p === "/" || p === "/agentglass") p = "/agentglass/";
      let file;
      if (p.startsWith("/agentglass/demo/")) {
        const rel = p.slice("/agentglass/demo/".length) || "index.html";
        file = Bun.file(join(DIST, rel === "" ? "index.html" : rel));
        if (!(await file.exists()) && !rel.split("/").pop()!.includes(".")) file = Bun.file(join(DIST, "index.html"));
      } else if (p.startsWith("/agentglass/")) {
        const rel = p.slice("/agentglass/".length) || "index.html";
        file = Bun.file(join(LANDING, rel === "" ? "index.html" : rel));
      } else return new Response("not found", { status: 404 });
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}/agentglass/`;
  const profile = mkdtempSync(join(tmpdir(), "agx-og-"));
  const port = 9500 + Math.floor(Math.random() * 200);
  const chrome = spawn({
    cmd: [findChrome(), "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      `--window-size=${W},${H}`, `--force-device-scale-factor=${SCALE}`, "--hide-scrollbars",
      "--no-first-run", "--no-sandbox", "--force-color-profile=srgb", "--enable-unsafe-swiftshader",
      "--force-prefers-reduced-motion", "about:blank"],
    stdout: "ignore", stderr: "ignore",
  });
  try {
    const cdp = await connect(port);
    // Graphite, injected before the app reads its theme, then the one load.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try{localStorage.setItem('agentglass-theme','graphite');localStorage.setItem('agentglass-theme-mode','dark');}catch(e){}`,
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
    await cdp.send("Page.navigate", { url });
    await until(cdp, `document.getElementById('gl')`, "the hero canvas", 20_000);
    // Let the intro slew settle onto a contact, and the app come up behind the
    // glass, so the card is the instrument doing its job rather than mid-sweep.
    await Bun.sleep(9000);
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
