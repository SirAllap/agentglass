#!/usr/bin/env bun
/**
 * The phone-companion figure for the README, from the demo build.
 *
 * mobile.png is three phone screens side by side under a caption each. It was
 * assembled by hand once and then sat in .github/assets as the only asset no
 * script could reproduce — which also made it the only one still in truecolour
 * at twice the weight of its neighbours. This is that assembly, written down.
 *
 * The three screens are the phone layout's three tabs, shot from the real
 * demo build at a real phone viewport (the layout switches itself below 768px,
 * see web/src/lib/viewport.ts), then composed into the figure by a page
 * rendered in the same browser — which is how the original was made, and the
 * only way the bezel, the shadow and the caption stay CSS rather than pixels.
 *
 *   cd web && bun run build:demo
 *   bun scripts/capture-phone.ts
 */

import { spawn } from "bun";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, findChrome, serveDist, until, clickByText, DEMO_BASE } from "./cdp.ts";
import { finishStill, STILL_W } from "./still.ts";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "web", "dist");
const OUT = join(ROOT, ".github", "assets");

/** A phone, at 3× so the composite can show it at 416px and stay sharp. */
const PHONE = { w: 390, h: 844, scale: 3 };
/** The figure, at the width every other still in the set is finished to. */
const FIG = { w: 1760, h: 990 };

/** Each tab, and what to do once it is open. The middle one drills into a
 *  repository, because a bare list says less about the product than the
 *  changes inside one does.
 *
 *  `after` pops that drill-down back off. It is not optional tidying: a pushed
 *  screen covers the tab bar, so without it the next tab click lands on
 *  nothing and the run silently shoots the same screen twice. */
const SCREENS: {
  tab: string; caption: string;
  then?: (cdp: any) => Promise<unknown>;
  after?: (cdp: any) => Promise<unknown>;
}[] = [
  { tab: "Now", caption: "Now" },
  {
    tab: "Repos", caption: "Repos",
    then: async (cdp) => {
      // The first repository in the list, then its Changes tab, which is
      // where the staging switches and the commit box live.
      await cdp.ev(`(()=>{const b=document.querySelector('main button');b?.click();return !!b})()`);
      await Bun.sleep(1400);
      await clickByText(cdp, "button", "Changes");
      await Bun.sleep(900);
    },
    after: async (cdp) => {
      const ok = await cdp.ev(`(()=>{const b=document.querySelector('[aria-label="Back"]');b?.click();return !!b})()`);
      if (!ok) throw new Error("no Back control on the repository screen");
      await Bun.sleep(900);
    },
  },
  { tab: "Chats", caption: "Chats" },
];

const figure = (shots: string[]) => `<meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:${FIG.w}px;height:${FIG.h}px;overflow:hidden;background:#141414;
  font-family:ui-monospace,"SF Mono",Menlo,monospace}
.bg{position:absolute;inset:0;background:
  radial-gradient(50% 42% at 78% -10%,color-mix(in srgb,#e5e5e5 7%,transparent),transparent),
  radial-gradient(46% 38% at 8% 2%,color-mix(in srgb,#e5e5e5 5%,transparent),transparent),
  linear-gradient(180deg,#1c1c1c,#141414 60%)}
.grid{position:absolute;inset:0;
  background-image:linear-gradient(color-mix(in srgb,#e5e5e5 4%,transparent) 1px,transparent 1px),
    linear-gradient(90deg,color-mix(in srgb,#e5e5e5 4%,transparent) 1px,transparent 1px);
  background-size:36px 36px;
  -webkit-mask-image:radial-gradient(120% 100% at 50% 0%,#000,transparent 82%)}
.row{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:58px}
figure{position:relative}
figure img{display:block;width:416px;height:900px;border-radius:24px;
  box-shadow:0 44px 90px -34px rgba(0,0,0,.95),0 0 0 1px color-mix(in srgb,#4c4c54 70%,transparent)}
figcaption{position:absolute;left:0;right:0;bottom:-34px;text-align:center;font-size:14px;
  letter-spacing:.22em;text-transform:uppercase;color:#a1a1a1}
</style>
<div class="bg"></div><div class="grid"></div>
<div class="row">${SCREENS.map((s, i) =>
  `<figure><img src="data:image/png;base64,${shots[i]}"><figcaption>${s.caption}</figcaption></figure>`).join("")}</div>`;

async function main() {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("no demo build — run: cd web && bun run build:demo");
    process.exit(1);
  }
  const server = serveDist(DIST);
  const url = `http://127.0.0.1:${server.port}${DEMO_BASE}/`;
  const profile = mkdtempSync(join(tmpdir(), "agx-phone-"));
  const work = mkdtempSync(join(tmpdir(), "agx-phone-fig-"));
  const port = 9700 + Math.floor(Math.random() * 200);

  const chrome = spawn({
    cmd: [findChrome(), "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      `--window-size=${PHONE.w},${PHONE.h}`, "--hide-scrollbars", "--no-first-run",
      "--no-default-browser-check", "--disable-gpu", "--no-sandbox", "--force-color-profile=srgb",
      // Deterministic frames: otherwise each shot catches the queue's
      // entry animations wherever they happened to be.
      // Start blank: the theme injection and the mobile emulation are set up
      // over CDP first, then the page is navigated once — a load that already
      // carries both, so there is no reload to drop the phone layout.
      "--force-prefers-reduced-motion", "about:blank"],
    stdout: "ignore", stderr: "ignore",
  });

  try {
    const cdp = await connect(port);
    // Two things, injected to run at document-start on the demo document, before
    // the app reads either — so the very first (and only) load already carries
    // them, with no reload to drop the mobile emulation:
    //   - Graphite (SERIOUS_DARK), the serious dark, not the old purple.
    //   - The phone-layout override. The published demo deliberately shows the
    //     cockpit to a phone visitor (wantsPhoneLayout returns false when demo),
    //     but this shot IS the companion, so the "mobile" override — which wins
    //     ahead of the demo rule — forces it.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try{localStorage.setItem('agentglass-theme','graphite');localStorage.setItem('agentglass-theme-mode','dark');localStorage.setItem('agentglass_layout','mobile');}catch(e){}`,
    });
    // mobile:true is what makes the layout switch — it is a coarse pointer,
    // not only a narrow window, that decides (web/src/lib/viewport.ts).
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: PHONE.w, height: PHONE.h, deviceScaleFactor: PHONE.scale, mobile: true,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp.send("Page.navigate", { url });
    await until(cdp, `document.querySelector('#root')?.children.length`, "the graphite phone");
    await until(cdp, `[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Repos'))`,
      "the phone layout (is this build wide-only?)");
    await Bun.sleep(2500); // let the demo stream seed a queue

    const shots: string[] = [];
    for (const s of SCREENS) {
      if (!await clickByText(cdp, "nav button, footer button, button", s.tab))
        throw new Error(`no "${s.tab}" tab in the phone layout`);
      await Bun.sleep(1200);
      if (s.then) await s.then(cdp);
      shots.push((await cdp.shot()).toString("base64"));
      console.log(`  ${s.caption}`);
      if (s.after) await s.after(cdp);
    }

    // A tab click that lands on nothing leaves the previous screen on screen,
    // and the run finishes looking perfectly successful with a duplicate in
    // the figure. It happened; hence the check.
    if (new Set(shots).size !== shots.length)
      throw new Error("two of the three screens are identical — a tab click did not land");

    // Compose in the same browser, at the figure's own size.
    const page = join(work, "figure.html");
    writeFileSync(page, figure(shots));
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: FIG.w, height: FIG.h, deviceScaleFactor: 2, mobile: false,
    });
    await cdp.send("Page.navigate", { url: `file://${page}` });
    await Bun.sleep(1600);
    const file = join(OUT, "mobile.png");
    writeFileSync(file, await cdp.shot());
    finishStill(file, STILL_W);
    console.log("  mobile.png");
    cdp.close();
  } finally {
    try { chrome.kill(); } catch { /* already gone */ }
    server.stop(true);
    rmSync(profile, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
