#!/usr/bin/env bun
/**
 * The one place the agentglass mark is drawn.
 *
 * The mark used to live as seven hand-copied inlines — a standalone SVG, a
 * favicon, a React component, the boot splash and three snippets in the
 * landing page. They drifted, and a fix to one of them shipped while another
 * kept the bug. So the drawing lives here now and every copy is generated
 * from it, between markers, with `--check` wired into CI to fail if any copy
 * has been hand-edited since.
 *
 *   bun scripts/logo.mjs           write every copy
 *   bun scripts/logo.mjs --check   verify every copy matches (CI)
 *
 * ── the drawing ───────────────────────────────────────────────────────────
 * A satellite pass: a shaded world, a steeply inclined orbit, and one live
 * contact on it. The contact is --success, the same green the queue uses for
 * "ready" — the fleet is up there working and exactly one thing is calling
 * home. The orbit is a line rather than a band and the inclination is steep
 * on purpose: a shallow band around a planet reads as Saturn, and a diagonal
 * fills a square icon slot the way the old loupe's handle did.
 *
 * ── two cuts ──────────────────────────────────────────────────────────────
 * Below 32px the simplified cut takes over. It is not the same drawing
 * scaled: the graticule and the specular gradient vanish, the orbit thickens
 * and the contact grows, because a 1px-wide detail at 16px is a smudge. This
 * is the ordinary rule for an icon set and the reason a 16px icon is drawn
 * rather than shrunk.
 *
 * ── two paints ────────────────────────────────────────────────────────────
 * Every value above and below the base colour is a white or an ink overlay,
 * never a second hue. That is what lets the in-app copy stay theme-reactive —
 * base becomes `currentColor` and the sphere still shades correctly whether
 * the theme's primary is violet, green, amber or blue — while the copies that
 * cannot inherit a theme (favicon, README, OG card) use the same geometry
 * with the violet literal substituted in.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

const INK = "#1b0b38";
const VIOLET = "#a78bfa";
const OK = "#34d399";

/** base: the hue everything is derived from. ok: the live contact. */
const FIXED = { base: VIOLET, ok: OK };
const REACTIVE = { base: "currentColor", ok: "var(--success)" };

// ── geometry, precomputed on a 64 grid ──────────────────────────────────
// Orbit: rx 29, tilt -52°. The two arcs share endpoints; the first is the
// half that passes behind the world, the second the half that passes in
// front, which is the whole trick that makes it read as an orbit.
const FULL = {
  orbit: { rx: 29, ry: 8, tilt: -52, w: 3.2, a: [14.1, 54.9], b: [49.9, 9.1] },
  world: { cx: 30, cy: 34, r: 12.5 },
  node: { cx: 50.8, cy: 10.7, r: 3.6, halo: 6.8 },
};
const SMALL = {
  orbit: { rx: 29, ry: 8.5, tilt: -52, w: 6, a: [14.1, 54.9], b: [49.9, 9.1] },
  world: { cx: 30, cy: 34, r: 15 },
  node: { cx: 50.7, cy: 10.4, r: 6 },
};

const arc = (o, from, to, stroke, opacity) =>
  `<path d="M${from[0]} ${from[1]} A${o.rx} ${o.ry} ${o.tilt} 0 1 ${to[0]} ${to[1]}" fill="none"`
  + ` stroke="${stroke}"${opacity ? ` stroke-opacity="${opacity}"` : ""}`
  + ` stroke-width="${o.w}" stroke-linecap="round"/>`;

/** The crescent that turns a flat disc into a sphere: the limb curving away. */
const terminator = (w, bulge, opacity) =>
  `<path d="M${w.cx} ${w.cy - w.r} A${w.r} ${w.r} 0 0 1 ${w.cx} ${w.cy + w.r}`
  + ` A${(w.r * bulge).toFixed(1)} ${(w.r * bulge).toFixed(1)} 0 0 0 ${w.cx} ${w.cy - w.r} Z"`
  + ` fill="${INK}" fill-opacity="${opacity}"/>`;

function full({ base, ok }, id) {
  const { orbit: o, world: w, node: n } = FULL;
  return [
    `<defs><radialGradient id="${id}" cx=".34" cy=".28" r=".82">`,
    `<stop offset="0" stop-color="#fff" stop-opacity=".72"/>`,
    `<stop offset=".5" stop-color="#fff" stop-opacity=".15"/>`,
    `<stop offset="1" stop-color="#fff" stop-opacity="0"/>`,
    `</radialGradient></defs>`,
    arc(o, o.a, o.b, base, ".4"),
    `<circle cx="${w.cx}" cy="${w.cy}" r="${w.r}" fill="${base}"/>`,
    `<circle cx="${w.cx}" cy="${w.cy}" r="${w.r}" fill="url(#${id})"/>`,
    `<g fill="none" stroke="#fff" stroke-opacity=".2" stroke-width="1.1">`,
    `<ellipse cx="${w.cx}" cy="${w.cy}" rx="${w.r}" ry="4.5"/>`,
    `<ellipse cx="${w.cx}" cy="${w.cy}" rx="6" ry="12.1"/>`,
    `</g>`,
    terminator(w, 1.36, ".42"),
    arc(o, o.b, o.a, base),
    `<circle cx="${n.cx}" cy="${n.cy}" r="${n.halo}" fill="${ok}" fill-opacity=".18"/>`,
    `<circle cx="${n.cx}" cy="${n.cy}" r="${n.r}" fill="${ok}"/>`,
  ].join("");
}

function small({ base, ok }) {
  const { orbit: o, world: w, node: n } = SMALL;
  return [
    arc(o, o.a, o.b, base, ".45"),
    `<circle cx="${w.cx}" cy="${w.cy}" r="${w.r}" fill="${base}"/>`,
    `<circle cx="${w.cx}" cy="${w.cy}" r="${w.r}" fill="#fff" fill-opacity=".34"/>`,
    terminator(w, 1.4, ".52"),
    arc(o, o.b, o.a, base),
    `<circle cx="${n.cx}" cy="${n.cy}" r="${n.r}" fill="${ok}"/>`,
  ].join("");
}

// ── the living mark ─────────────────────────────────────────────────────
/*
 * The landing's header mark is alive: the contact rides its orbit once every
 * sixteen seconds, across the face of the world for one half and behind it
 * for the other. The landing moves it with SMIL <animateMotion>, and the app
 * cannot: SMIL is ticked on the main thread, and the one place this mark
 * matters most — the launch cover — is exactly when the main thread is busy
 * parsing and mounting the app. A SMIL orbit stutters for the whole of it.
 *
 * So the same path is drawn with CSS transforms, which the compositor runs on
 * its own thread whatever the page is doing: the orbit's plane is a circle
 * squashed by ry/rx and tilted, an arm turns inside it, and the contact at
 * the arm's end counter-turns so it stays round. The arm's keyframes are
 * PACED — spaced by arc length, not by angle — because that is what
 * <animateMotion> does by default: at constant angular speed the contact
 * races across the face and crawls at the tips, and it is no longer the
 * landing's orbit. Stops every 5° keep its speed within 5% of constant.
 *
 * The drawing is the full cut and it is split in two layers, behind and in
 * front of the contact, which is the whole trick the SVG plays with its two
 * arcs: two copies of the contact ride the orbit in step, the one under the
 * world shown for the back half, the one over it for the front half.
 */
const FAR = { rx: 36, ry: 14, tilt: -18, w: 1, a: [-2.2, 43.1], b: [66.2, 20.9] };

/** [offset %, angle°] stops for one turn at constant speed along the ellipse. */
function paced(rx, ry, step = 5) {
  const N = 7200;
  const speed = (deg) => { const t = (deg * Math.PI) / 180; return Math.hypot(rx * Math.sin(t), ry * Math.cos(t)); };
  const s = [0];
  for (let i = 1; i <= N; i++) s.push(s[i - 1] + ((speed(((i - 1) * 360) / N) + speed((i * 360) / N)) / 2) * (360 / N));
  const stops = [];
  for (let d = 0; d <= 360; d += step) stops.push([+((s[(d * N) / 360] / s[N]) * 100).toFixed(3), d]);
  return stops;
}

/**
 * The CSS for one orbiting contact, as `<prefix>-o` (the plane, which also
 * shows or hides its copy for its half), `<prefix>-arm` and `<prefix>-dot`.
 * Every length is a percentage of the 64-unit box, so the same rules draw it
 * at 22px in the title bar and at 260px on the cover.
 */
function orbitCss(p, o, { dur, halo, r, color, haloAlpha, coreAlpha, easing = "linear" }) {
  const k = o.rx / o.ry;
  const pct = (u) => +((u / 64) * 100).toFixed(4);
  const box = pct(2 * halo);
  const stops = paced(o.rx, o.ry);
  const arm = stops.map(([at, d]) => `${at}%{transform:rotate(${d}deg)}`).join("");
  const dot = stops.map(([at, d]) => `${at}%{transform:rotate(${d ? -d : 0}deg) scaleY(${+k.toFixed(4)}) rotate(${-o.tilt}deg)}`).join("");
  return [
    `.${p}-o{position:absolute;inset:0;transform:rotate(${o.tilt}deg) scaleY(${+(1 / k).toFixed(5)})}`,
    `.${p}-b{opacity:0}`,
    `.${p}-arm{position:absolute;inset:0}`,
    `.${p}-dot{position:absolute;left:${+(50 + pct(o.rx) - box / 2).toFixed(4)}%;top:${+(50 - box / 2).toFixed(4)}%;width:${box}%;height:${box}%;`
      + `border-radius:50%;background:color-mix(in srgb,${color} ${haloAlpha * 100}%,transparent);`
      + `transform:scaleY(${+k.toFixed(4)}) rotate(${-o.tilt}deg)}`,
    `.${p}-dot::after{content:"";position:absolute;inset:${+(((halo - r) / (2 * halo)) * 100).toFixed(3)}%;border-radius:50%;`
      + `background:${color};opacity:${coreAlpha}}`,
    `.${p}-o,.${p}-arm,.${p}-dot{animation-duration:${dur}s;animation-iteration-count:infinite}`,
    `.${p}-arm{animation-name:${p}-arm;animation-timing-function:${easing}}`,
    `.${p}-dot{animation-name:${p}-dot;animation-timing-function:${easing}}`,
    `.${p}-f{animation-name:${p}-f;animation-timing-function:step-end}`,
    `.${p}-b{animation-name:${p}-b;animation-timing-function:step-end}`,
    `@keyframes ${p}-f{0%{opacity:1}50%,100%{opacity:0}}`,
    `@keyframes ${p}-b{0%{opacity:0}50%,100%{opacity:1}}`,
    `@keyframes ${p}-arm{${arm}}`,
    `@keyframes ${p}-dot{${dot}}`,
    `@media (prefers-reduced-motion:reduce){.${p}-o,.${p}-arm,.${p}-dot{animation:none}}`,
  ].join("\n");
}

/** Everything the living mark and the cover's far orbit need, as one sheet. */
function livingCss() {
  const { orbit: o, node: n } = FULL;
  return [
    `.ag-lm{position:relative;display:block;width:100%;height:100%;color:var(--primary,#58a6ff)}`,
    `.ag-lm>svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}`,
    /* Stepped: two moves per keyframe, about nine a second. Measured in the
       desktop app (software-composited on Linux), a contact moving every frame
       cost the window about five points of one core for as long as it was
       looked at; stepped, about one. At 22px the contact covers some three
       pixels a second, so a step is a fraction of one and reads as smooth. The
       cover's big mark sets it back to every frame (web/index.html). */
    orbitCss("ag-lm", o, { dur: 16, halo: n.halo, r: n.r, color: "var(--success,#3fb950)", haloAlpha: 0.18, coreAlpha: 1, easing: "steps(2,jump-none)" }),
    orbitCss("agc-far", FAR, { dur: 48, halo: 2.2, r: 0.9, color: "var(--warning,#d29922)", haloAlpha: 0.16, coreAlpha: 0.8 }),
    /* The title bar's own copy of the arm and dot (Logo.tsx) orbited any time
       the app was not idle — including long after the cover it was meant to
       hand off to had come down and gone, so the mark in the title bar never
       actually stood still. Paused outside the cover; the idle rule below
       only ever adds a second reason to pause, never a reason to run beyond
       it. The cover's own big mark is unaffected — it is forced linear, see
       `#ag-cover :is(.ag-lm-arm, .ag-lm-dot)` in web/index.html. */
    `.ag-lm-arm,.ag-lm-dot{animation-play-state:paused}`,
    `:root.ag-covering :is(.ag-lm-arm,.ag-lm-dot){animation-play-state:running}`,
    /* Frozen with the rest of the app's ambient loops while nobody is looking
       (useLive.ts sets data-idle) — but never while the cover is up: the mark
       in the title bar takes over from the one flying in, orbit and all. */
    `:root[data-idle="1"]:not(.ag-covering) :is(.ag-lm-o,.ag-lm-arm,.ag-lm-dot){animation-play-state:paused}`,
  ].join("\n");
}

/** The living mark's markup: the full cut split around two riding contacts. */
function living(id) {
  const { orbit: o, world: w } = FULL;
  const rider = (half) => `<span class="ag-lm-o ag-lm-${half}"><span class="ag-lm-arm"><span class="ag-lm-dot"></span></span></span>`;
  return [
    `<span class="ag-lm">`,
    `<svg viewBox="0 0 64 64" aria-hidden="true">${arc(o, o.a, o.b, "currentColor", ".4")}</svg>`,
    rider("b"),
    `<svg viewBox="0 0 64 64" aria-hidden="true">`,
    `<defs><radialGradient id="${id}" cx=".34" cy=".28" r=".82">`,
    `<stop offset="0" stop-color="#fff" stop-opacity=".72"/>`,
    `<stop offset=".5" stop-color="#fff" stop-opacity=".15"/>`,
    `<stop offset="1" stop-color="#fff" stop-opacity="0"/>`,
    `</radialGradient></defs>`,
    `<circle cx="${w.cx}" cy="${w.cy}" r="${w.r}" fill="currentColor"/>`,
    `<circle cx="${w.cx}" cy="${w.cy}" r="${w.r}" fill="url(#${id})"/>`,
    `<g fill="none" stroke="#fff" stroke-opacity=".2" stroke-width="1.1">`,
    `<ellipse cx="${w.cx}" cy="${w.cy}" rx="${w.r}" ry="4.5"/>`,
    `<ellipse cx="${w.cx}" cy="${w.cy}" rx="6" ry="12.1"/>`,
    `</g>`,
    terminator(w, 1.36, ".42"),
    arc(o, o.b, o.a, "currentColor"),
    `</svg>`,
    rider("f"),
    `</span>`,
  ].join("");
}

/** The cover's far orbit, one dashed half at a time: `back` sits under the
 *  mark, `front` over it, the same split the mark itself uses. */
function farHalf(half) {
  const [from, to, alpha] = half === "b" ? [FAR.a, FAR.b, ".16"] : [FAR.b, FAR.a, ".22"];
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M${from[0]} ${from[1]} A${FAR.rx} ${FAR.ry} ${FAR.tilt} 0 1 ${to[0]} ${to[1]}"`
    + ` fill="none" stroke="currentColor" stroke-opacity="${alpha}" stroke-width="${FAR.w}" stroke-dasharray="2 5"`
    + ` vector-effect="non-scaling-stroke"/></svg>`
    + `<span class="agc-far-o agc-far-${half}"><span class="agc-far-arm"><span class="agc-far-dot"></span></span></span>`;
}

/** Same markup, JSX attribute casing.
 *
 *  One rule, and only one is needed: the hyphenated SVG attributes this mark
 *  uses (`stop-color`, `stop-opacity`, `stroke-width`, `stroke-linecap`,
 *  `fill-opacity`) become camelCase. The element names carry over untouched,
 *  `<stop>` included, which is why the second pass that used to sit here
 *  replaced `<stop ` with `<stop ` and did nothing at all. */
const jsx = (s) => s
  .replace(/\b(stroke|fill|stop)-(width|opacity|linecap|color)="/g,
    (_, a, b) => `${a}${b[0].toUpperCase()}${b.slice(1)}="`);

// ── the copies ──────────────────────────────────────────────────────────
/** One tag per line, indented — these files get read and reviewed by hand. */
const lines = (body, indent) => body.replace(/></g, `>\n${indent}<`);

const wrap = (body, attrs) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"${attrs}>\n  `
  + lines(body, "  ") + "\n</svg>\n";

const files = {
  // README masthead, and the source the OG card is drawn from.
  ".github/assets/logo.svg": wrap(full(FIXED, "sheen"), ` width="88" height="88" role="img" aria-label="agentglass"`),

  // Browser tab and home screen. Small cut: it is never seen above 32px.
  "web/public/favicon.svg": wrap(small(FIXED), ""),

  // Android masks a maskable icon to a circle and clips whatever crosses the
  // safe zone, which a full-bleed diagonal does. So the maskable copy is the
  // mark at 62% on the app's own background rather than the bare glyph.
  "web/public/icon-maskable.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="#0f0a1a"/>
  <g transform="translate(32 32) scale(.62) translate(-32 -32)">
    ${lines(full(FIXED, "sheen"), "    ")}
  </g>
</svg>
`,
};

/** Inline copies, replaced between markers so a hand-edit is caught by --check. */
const blocks = [
  // The launch cover: the living mark, the far orbit's two halves around it,
  // and the one sheet both the cover and the title bar's mark are drawn by.
  // Inline in the page because the cover has to paint before the bundle does.
  {
    file: "web/index.html",
    open: "<!-- living:start -->", close: "<!-- living:end -->",
    body: () => `\n            ` + lines(living("agc-sheen"), "            ") + `\n            `,
  },
  {
    file: "web/index.html",
    open: "<!-- far:back:start -->", close: "<!-- far:back:end -->",
    body: () => `\n          ` + lines(farHalf("b"), "          ") + `\n          `,
  },
  {
    file: "web/index.html",
    open: "<!-- far:front:start -->", close: "<!-- far:front:end -->",
    body: () => `\n          ` + lines(farHalf("f"), "          ") + `\n          `,
  },
  {
    file: "web/index.html",
    open: "/* living:css:start */", close: "/* living:css:end */",
    body: () => "\n" + livingCss() + "\n      ",
  },
  {
    file: "landing/index.html",
    open: "<!-- logo:favicon:start -->", close: "<!-- logo:favicon:end -->",
    body: () => `\n<link rel="icon" href="data:image/svg+xml,`
      + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${small(FIXED)}</svg>`)
      + `">\n`,
  },
  {
    file: "landing/index.html", all: true,
    open: "<!-- logo:mark:start -->", close: "<!-- logo:mark:end -->",
    // The landing never draws the mark above 19px, so both inline copies are
    // the small cut and neither carries a gradient — no id to collide.
    body: (attrs) => `<svg class="mark" viewBox="0 0 64 64" ${attrs} aria-hidden="true">${small(REACTIVE)}</svg>`,
  },
  {
    file: "web/src/components/Logo.tsx",
    open: "      {/* living:start */}", close: "      {/* living:end */}",
    body: () => "\n      " + jsx(living("$SHEEN$"))
      .replace(/ class="/g, ' className="')
      .replace('id="$SHEEN$"', "id={sheen}")
      .replace('fill="url(#$SHEEN$)"', "fill={`url(#${sheen})`}") + "\n",
  },
  {
    file: "web/src/components/Logo.tsx",
    open: "      {/* logo:start */}", close: "      {/* logo:end */}",
    body: () => `\n      {size < 32 ? (\n        <>${jsx(small(REACTIVE))}</>\n      ) : (\n        <>${
      jsx(full(REACTIVE, "$SHEEN$"))
        .replace('id="$SHEEN$"', "id={sheen}")
        .replace('fill="url(#$SHEEN$)"', "fill={`url(#${sheen})`}")}</>\n      )}\n`,
  },
];

let failed = [];
const io = (rel, next) => {
  const path = join(ROOT, rel);
  const prev = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (prev === next) return;
  if (CHECK) { failed.push(rel); return; }
  writeFileSync(path, next);
  console.log("wrote", rel);
};

for (const [rel, body] of Object.entries(files)) io(rel, body);

for (const b of blocks) {
  const path = join(ROOT, b.file);
  let src = readFileSync(path, "utf8");
  const re = new RegExp(
    `(${b.open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})([\\s\\S]*?)(${b.close.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
    b.all ? "g" : "");
  if (!re.test(src)) { console.error(`missing markers in ${b.file}: ${b.open}`); process.exit(1); }
  src = src.replace(re, (_, open, inner, close) => {
    // Carry the caller's width/height through: the landing draws the same
    // mark at 19px in the rail and 13px in the by-line.
    const attrs = (inner.match(/width="\d+" height="\d+"/) || ['width="19" height="19"'])[0];
    return open + b.body(attrs) + close;
  });
  io(b.file, src);
}

if (CHECK && failed.length) {
  console.error("the mark is out of date in:\n  " + failed.join("\n  ")
    + "\nrun: bun scripts/logo.mjs");
  process.exit(1);
}
if (CHECK) console.log("the mark is in sync everywhere");
