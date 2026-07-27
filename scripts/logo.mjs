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

/** Same markup, JSX attribute casing. */
const jsx = (s) => s
  .replace(/\b(stroke|fill|stop)-(width|opacity|linecap|color)="/g,
    (_, a, b) => `${a}${b[0].toUpperCase()}${b.slice(1)}="`)
  .replace(/<stop /g, "<stop ");

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
  {
    file: "web/index.html",
    open: "<!-- logo:start -->", close: "<!-- logo:end -->",
    body: () => `\n        <svg class="ag-mark" viewBox="0 0 64 64" aria-hidden="true">\n          `
      + lines(full(FIXED, "boot"), "          ") + `\n        </svg>\n        `,
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
