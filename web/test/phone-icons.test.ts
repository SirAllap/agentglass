/*
 * The two places a phone reads an icon from, and the file formats they
 * actually accept.
 *
 * Everything this page offered was an SVG, and both of these handle SVG worst:
 * iOS ignores `apple-touch-icon` unless it is a raster and screenshots the page
 * instead, and Android's install and splash path wants a raster 192 and 512.
 * Neither fails loudly — you get a home-screen thumbnail of a dashboard —
 * which is why it survived this long and why it is asserted here rather than
 * looked at.
 *
 * There was a third: a pushed notification's `icon` and `badge`, read out of
 * the service worker. Web Push is gone, so the worker and the badge stencil
 * went with it and nothing here reads them.
 *
 * Written against the references themselves rather than against a list of
 * filenames, so pointing one back at an SVG fails even if every file survives.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

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
    // The QR flow ends in a browser tab somebody will lose, so Add to Home
    // Screen is the step that turns the cockpit into something they can open
    // again — and it was the step that gave them a screenshot of the page
    // instead of the mark.
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

  /*
   * There was an alpha-channel check here, and it was about the notification
   * badge: a stencil drawn from the alpha channel alone, which comes back as a
   * white square if the renderer forgets to clear the default background. It
   * went with Web Push. Nothing replaced it, because there is nothing to
   * replace it with — every mark left is full-bleed, and all four PNGs are
   * colour-type 2 with no alpha at all. Asserting the opposite of what the
   * files are would have been a test that only ever proved itself.
   */
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

  test("the manifest's own icons follow the same rule", () => {
    // Same reason as the head: `start_url` and `scope` are relative so an
    // installed copy resolves against whatever host it was installed from, and
    // an icon baked to one base is the assumption they refuse to make.
    const m = JSON.parse(read("public/manifest.webmanifest")) as { icons: { src: string }[] };
    for (const i of m.icons) expect(i.src.startsWith("/"), `${i.src} is rooted at the host`).toBe(false);
  });
});

describe("the rasters are generated, not drawn", () => {
  test("every PNG has a source SVG and a line in the generator", () => {
    // Four binaries nobody can regenerate when the mark changes is the failure
    // this avoids. If the generator stops naming one, that file is orphaned.
    const gen = read("../scripts/make-icons.ts");
    for (const png of ["apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
      expect(gen, `${png} is not produced by make-icons.ts`).toContain(`"${png}"`);
      expect(isPng("public/" + png)).toBe(true);
    }
    for (const svg of ["icon-app.svg", "icon-maskable.svg"]) {
      expect(existsSync(at("public/" + svg)), `${svg} is missing`).toBe(true);
      expect(gen).toContain(`"${svg}"`);
    }
  });

  test("and nothing is left in public/ that the generator has forgotten", () => {
    // The other direction, which is the one that let the notification badge
    // survive the feature it was drawn for: a file the generator no longer
    // names is art nobody will ever regenerate, for a surface that may not
    // exist any more.
    const gen = read("../scripts/make-icons.ts");
    for (const f of readdirSync(at("public")).filter((f) => /^icon-|^apple-touch-/.test(f))) {
      expect(gen, `public/${f} is not named by make-icons.ts`).toContain(`"${f}"`);
    }
  });

  test("and none of them is an empty frame", () => {
    // A render that ran before the SVG painted comes back as a valid, tiny,
    // blank PNG — which every check above would pass.
    for (const [png, least] of [["apple-touch-icon.png", 3000], ["icon-192.png", 3000],
      ["icon-512.png", 10_000], ["icon-maskable-512.png", 8000]] as const) {
      expect(statSync(at("public/" + png)).size, `${png} looks blank`).toBeGreaterThan(least);
    }
  });
});
