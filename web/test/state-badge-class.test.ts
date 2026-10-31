import { expect, test } from "bun:test";

// The global `.tile` card in index.css carries padding and flex-column; a state badge's icon box that reused the name
// was pushed to the bottom-right of its square. Its own class keeps the glyph centred.
test("the state badge's icon box does not reuse the global .tile class", async () => {
  const src = await Bun.file(new URL("../src/components/flightPlan/StateBadge.tsx", import.meta.url)).text();
  expect(src.includes('className="tile"')).toBe(false);
  expect(src.includes('className="st-ico"')).toBe(true);
  for (const f of ["pilotView.css", "flightPlanView.css"]) {
    const css = await Bun.file(new URL(`../src/components/flightPlan/${f}`, import.meta.url)).text();
    expect(/\.pv-state[^{]*\.tile\b/.test(css)).toBe(false);
  }
});

// A fixed 760-unit SVG stretched to a wide box drew 12.5 px labels at 17 px. The trajectory is HTML now: type keeps its size.
test("the trajectory is plain HTML, not a stretched SVG", async () => {
  const src = await Bun.file(new URL("../src/components/flightPlan/Trajectory.tsx", import.meta.url)).text();
  expect(src.includes("<svg")).toBe(false);
  expect(src.includes("viewBox")).toBe(false);
  expect(src.includes("on stn")).toBe(true);
  expect(src.includes("export function trackLabel(")).toBe(true);
  expect(src.includes("export function Track(")).toBe(true);
});

// The orrery is placed by the angle alone, so a change of station swings it with transforms and never lays out again,
// and every colour comes from the theme so the orbit follows the accent, light or dark.
test("the trajectory's orbit is transform-placed and painted only with tokens", async () => {
  const css = await Bun.file(new URL("../src/components/flightPlan/flightPlanView.css", import.meta.url)).text();
  const start = css.indexOf("@property --ang");
  const end = css.indexOf("@keyframes fp-pulse");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = css.slice(start, end);
  expect(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(block)).toBe(false);
  expect(/\.on \{[^}]*transform: translate\(calc\(50cqw \+ cos\(var\(--ang\)\)/.test(block)).toBe(true);
  expect(/\.on \{[^}]*transition: --ang /.test(block)).toBe(true);
  expect(/transition:[^;]*\b(left|top|width|height)\b/.test(block)).toBe(false);
  expect(/\.lbl \{ font-size: 12px;/.test(block)).toBe(true);
  expect(/\.sub \{ font-size: 11px;/.test(block)).toBe(true);
});

// The current station is the living mark; its moon only runs inside the trajectory, only when motion is welcome, and
// never while the window is idle (the global sheet pauses it by default).
test("the trajectory's mark is the living one and its moon runs only under no-preference", async () => {
  const src = await Bun.file(new URL("../src/components/flightPlan/Trajectory.tsx", import.meta.url)).text();
  expect(src.includes("<LivingMark")).toBe(true);
  const css = await Bun.file(new URL("../src/components/flightPlan/flightPlanView.css", import.meta.url)).text();
  const i = css.indexOf('animation-play-state: running');
  expect(i).toBeGreaterThan(-1);
  const open = css.lastIndexOf("@media", i);
  expect(css.slice(open, css.indexOf("{", open))).toContain("prefers-reduced-motion: no-preference");
  expect(/animation:\s*fp-sig [^;]*infinite/.test(css)).toBe(false);
  expect(/animation:\s*fp-sig [^;]*\b1\b/.test(css)).toBe(true);
  expect(css.slice(css.lastIndexOf("\n", i), i)).toContain('[data-idle="1"]');
});
