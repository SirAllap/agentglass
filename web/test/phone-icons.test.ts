/*
 * The three places a phone reads an icon from, and the file formats they
 * actually accept.
 *
 * Everything the companion offered was an SVG, and all three of these handle
 * SVG worst: iOS ignores `apple-touch-icon` unless it is a raster and
 * screenshots the page instead, Android's install and splash path wants a
 * raster 192 and 512, and Chrome is not expected to draw an SVG notification
 * icon. None of that fails loudly — you get a home-screen thumbnail of a
 * dashboard and somebody else's glyph on your lock screen — which is why it
 * survived this long and why it is asserted here rather than looked at.
 *
 * Written against the references themselves rather than against a list of
 * filenames, so pointing one back at an SVG fails even if every file survives.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";

const at = (p: string) => new URL("../" + p, import.meta.url).pathname;
const read = (p: string) => readFileSync(at(p), "utf8");

/** A real PNG, by its magic number — not by the name somebody gave the file. */
function isPng(p: string): boolean {
  if (!existsSync(at(p))) return false;
  const head = readFileSync(at(p)).subarray(0, 8);
  return head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

describe("the icons a phone reads", () => {
  test("apple-touch-icon is a PNG that exists", () => {
    // The one that matters most: on iPhone, Web Push works only for a site
    // added to the Home Screen, so Add to Home Screen is the first thing an
    // iPhone user is told to do — and it was the step that gave them a
    // screenshot of the page instead of the mark.
    const html = read("index.html");
    const href = html.match(/<link rel="apple-touch-icon"[^>]*href="([^"]+)"/)?.[1];
    expect(href, "there is no apple-touch-icon at all").toBeTruthy();
    expect(href!.endsWith(".png"), `apple-touch-icon is ${href} — iOS does not support SVG here`).toBe(true);
    expect(isPng("public/" + href!.replace(/^\.\//, ""))).toBe(true);
  });

  test("the manifest offers a raster 192 and 512", () => {
    const m = JSON.parse(read("public/manifest.webmanifest")) as {
      icons: { src: string; sizes: string; type: string; purpose: string }[];
    };
    const png = m.icons.filter((i) => i.type === "image/png");
    for (const size of ["192x192", "512x512"]) {
      const hit = png.find((i) => i.sizes === size && i.purpose === "any");
      expect(hit, `no PNG ${size} for purpose "any"`).toBeTruthy();
      expect(isPng("public/" + hit!.src.replace(/^\.\//, ""))).toBe(true);
    }
    // …and something a launcher can crop to its own shape without clipping the
    // mark, which is what `maskable` means.
    const maskable = m.icons.filter((i) => i.purpose === "maskable");
    expect(maskable.length).toBeGreaterThan(0);
    expect(maskable.some((i) => i.type === "image/png")).toBe(true);
  });

  test("the notification icon and badge are PNGs, and are not the same file", () => {
    const sw = read("public/sw.js");
    const icon = sw.match(/\bicon:\s*"([^"]+)"/)?.[1];
    const badge = sw.match(/\bbadge:\s*"([^"]+)"/)?.[1];
    expect(icon?.endsWith(".png"), `notification icon is ${icon}`).toBe(true);
    expect(badge?.endsWith(".png"), `notification badge is ${badge}`).toBe(true);
    // Android draws the badge from the alpha channel as a flat silhouette, so
    // the full-colour mark reduces to a blob. They have to be different art.
    expect(badge).not.toBe(icon);
    expect(isPng("public/" + icon!.replace(/^\.\//, ""))).toBe(true);
    expect(isPng("public/" + badge!.replace(/^\.\//, ""))).toBe(true);
  });

  test("the badge keeps its transparency", () => {
    // A badge composited onto opaque white is a white square with a slightly
    // whiter mark on it — which is what happens if the renderer forgets to
    // clear the default background. Cheap proxy for "it has an alpha channel":
    // byte 25 of the IHDR is the colour type, and 6 is RGBA.
    const raw = readFileSync(at("public/icon-badge.png"));
    expect(raw[25], "icon-badge.png has no alpha channel").toBe(6);
  });
});

describe("the paths those icons are reached by", () => {
  test("nothing in the head is rooted at the host", () => {
    // Not because the absolute form 404s on the demo — it was reported that
    // way and it does not: Vite rewrites `/favicon.svg` to
    // `/agentglass/demo/favicon.svg` at build time, which was checked by
    // building it both ways.
    //
    // It is because the built copy is served from more than one root and only
    // one of them is known when it is built. `start_url` and `scope` in the
    // manifest are relative on purpose — an installed copy has to resolve
    // against whatever host it was installed from — and an icon link baked to
    // one base is the same assumption the manifest deliberately refuses to
    // make. The two icon links were the only things in the head not following
    // the rule the manifest link beside them already followed.
    const head = read("index.html").split("</head>")[0]!;
    const rooted = [...head.matchAll(/<link[^>]+href="(\/[^/"][^"]*)"/g)].map((m) => m[1]);
    expect(rooted, "an absolute asset path breaks the demo build").toEqual([]);
  });

  test("the service worker asks for its icons relative to itself", () => {
    const sw = read("public/sw.js");
    for (const [, href] of sw.matchAll(/\b(?:icon|badge):\s*"([^"]+)"/g)) {
      expect(href!.startsWith("./"), `${href} is not relative`).toBe(true);
    }
  });
});

describe("the rasters are generated, not drawn", () => {
  test("every PNG has a source SVG and a line in the generator", () => {
    // Five binaries nobody can regenerate when the mark changes is the failure
    // this avoids. If the generator stops naming one, that file is orphaned.
    const gen = read("../scripts/make-icons.ts");
    for (const png of ["apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "icon-badge.png"]) {
      expect(gen, `${png} is not produced by make-icons.ts`).toContain(`"${png}"`);
      expect(isPng("public/" + png)).toBe(true);
    }
    for (const svg of ["icon-app.svg", "icon-maskable.svg", "icon-badge.svg"]) {
      expect(existsSync(at("public/" + svg)), `${svg} is missing`).toBe(true);
      expect(gen).toContain(`"${svg}"`);
    }
  });

  test("and none of them is an empty frame", () => {
    // A render that ran before the SVG painted comes back as a valid, tiny,
    // blank PNG — which every check above would pass.
    for (const [png, least] of [["apple-touch-icon.png", 3000], ["icon-192.png", 3000],
      ["icon-512.png", 10_000], ["icon-maskable-512.png", 8000], ["icon-badge.png", 700]] as const) {
      expect(statSync(at("public/" + png)).size, `${png} looks blank`).toBeGreaterThan(least);
    }
  });
});
