#!/usr/bin/env bun
/**
 * How much of its own box each rail glyph actually inks.
 *
 * The rail's icons are all one size and did not look it. `size` sets the SVG
 * box; what a person sees is the DRAWING inside it, and these icons come from
 * three different places — a stroked set at 24, Git's official mark at 15,
 * Docker's whale bleeding past its own edges. Measured, they ran from 44% of
 * the box (the old terminal glyph, a chevron floating in space) to 104%
 * (Docker), which is why a strip of nominally identical icons read as a jumble.
 *
 * One caveat the numbers cannot express: the band measures a BOUNDING BOX, and
 * a rotated square fills its own box with half the ink an upright one does. The
 * Git mark is a diamond and reads as the runt of the rail at 83%; it fills its
 * box corner to corner on purpose. A shape whose silhouette is not roughly
 * square needs the number read with that in mind rather than obeyed.
 *
 * There is no DOM in the test suite, so this cannot be a test: `getBBox` is the
 * only thing that knows where a path actually goes, and it needs a browser. So
 * it is a script, and the band it reports is the check — every rail glyph should
 * sit near TARGET, and anything outside prints the viewBox that would fix it,
 * centred on the ink, so the correction is arithmetic rather than taste.
 *
 *   cd web && VITE_DEMO=1 bun run dev --port 6181
 *   bun scripts/icon-ink.ts
 */
import { spawn } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, findChrome, key, until } from "./cdp.ts";

/** The fraction of its box a glyph should cover, on its longest side. It is
 *  where the healthy majority already sat — the ones nobody had complained
 *  about — rather than a number chosen in the abstract. */
const TARGET = 0.83;
/** How far off TARGET is worth reporting. Under this the difference is not
 *  visible beside a neighbour, and chasing it would be churn. */
const TOLERANCE = 4;

const URL_ = process.env.PROBE_URL ?? "http://127.0.0.1:6181/agentglass/demo/";
const profile = mkdtempSync(join(tmpdir(), "agx-ink-"));
const port = 9600 + Math.floor(Math.random() * 90);
const chrome = spawn({
  cmd: [findChrome(), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--headless=new", "--window-size=1400,900", "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--hide-scrollbars", URL_],
  stdout: "ignore", stderr: "ignore",
});

try {
  const cdp = await connect(port);
  await until(cdp, `document.querySelector('#root')?.children.length`, "the app to mount");
  await Bun.sleep(800);
  await key(cdp, "\\", { ctrlKey: true });
  await until(cdp, `document.querySelector('[data-view="dash"]')`, "the rail");
  await Bun.sleep(900);

  const rows: { name: string; wide: number; tall: number; big: number; viewBox: string; fix: string | null }[] =
    await cdp.ev(`(()=>{
      const nav = document.querySelector('[role="tablist"][aria-label="Workspace views"]');
      const out = [];
      for (const btn of nav.querySelectorAll('button')) {
        const svg = btn.querySelector('svg');
        if (!svg) continue;
        const vb = (svg.getAttribute('viewBox') || '0 0 24 24').split(/\\s+/).map(Number);
        const side = vb[2] || 24;
        let bb; try { bb = svg.getBBox(); } catch { continue; }
        // getBBox measures the path; a stroke draws half its width outside it.
        const sw = parseFloat(getComputedStyle(svg).strokeWidth || '0') || 0;
        const w = bb.width + sw, h = bb.height + sw, big = Math.max(w, h);
        const need = big / ${TARGET};
        const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
        out.push({
          name: btn.dataset.view || (btn.getAttribute('aria-label') || btn.getAttribute('title') || '?').slice(0, 14),
          wide: +(100 * w / side).toFixed(0),
          tall: +(100 * h / side).toFixed(0),
          big: +(100 * big / side).toFixed(0),
          viewBox: svg.getAttribute('viewBox'),
          fix: Math.abs(100 * big / side - ${100 * TARGET}) > ${TOLERANCE}
            ? [cx - need / 2, cy - need / 2, need, need].map((n) => +n.toFixed(2)).join(' ')
            : null,
        });
      }
      return out.sort((a, b) => a.big - b.big);
    })()`);

  console.log(`glyph as a share of its own box (target ${100 * TARGET}% ±${TOLERANCE})\n`);
  for (const r of rows) {
    const flag = r.fix ? "  ← " + `viewBox "${r.viewBox}" → "${r.fix}"` : "";
    console.log(`  ${r.name.padEnd(16)} w ${String(r.wide).padStart(3)}%  h ${String(r.tall).padStart(3)}%  max ${String(r.big).padStart(3)}%${flag}`);
  }
  const off = rows.filter((r) => r.fix);
  console.log(off.length ? `\n${off.length} outside the band. Widening a viewBox shrinks the glyph, so scale strokeWidth by the same factor or the line thins with it.` : "\nall within the band.");
  cdp.close();
  process.exit(off.length ? 1 : 0);
} finally {
  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
}
