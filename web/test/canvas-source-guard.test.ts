/*
 * What a live canvas must never contain, read off its source.
 *
 * A canvas draws data a plugin sent, in the window that holds the API token and
 * can open a shell. So the files that draw it may not contain the few things
 * that turn a string into something that runs, loads or navigates: markup
 * injection, a lookup of the DOM by a scene's id, an image, a link, a frame, a
 * style built from text, or Markdown (which renders images by URL and would make
 * the window fetch on its own). There is no renderer in this project to mount
 * the view and see it happen, so the rule is asserted against the source, with
 * comments stripped: a comment may say why `innerHTML` is not here.
 */
import { describe, expect, test } from "bun:test";

const ROOT = new URL("../", import.meta.url).pathname;
const FILES = [
  "src/components/plugins/PluginCanvas.tsx",
  "src/lib/canvasGeometry.ts",
  "src/lib/canvasLive.ts",
  "src/lib/canvasState.ts",
  "src/lib/canvasMotion.ts",
  "src/components/plugins/CanvasBoard.tsx",
  "src/components/plugins/canvasRead.ts",
  "src/components/plugins/canvasBoard.css",
  "src/components/plugins/CanvasSheet.tsx",
  "src/components/plugins/CanvasDock.tsx",
  "src/components/plugins/canvasSheet.css",
  "src/components/plugins/canvasDock.css",
  "src/lib/canvasOrbit.ts",
  "src/lib/canvasFlash.ts",
  "src/lib/canvasView.ts",
] as const;
const sources = new Map(await Promise.all(FILES.map(async (f) => [f, await Bun.file(`${ROOT}${f}`).text()] as const)));

/** Block comments, then whatever follows `//` on a line (not one inside a URL). */
export function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1")).join("\n");
}

export const FORBIDDEN: { name: string; re: RegExp; sample: string }[] = [
  { name: "innerHTML and its kin", re: /\b(?:innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|srcdoc)\b/, sample: "el.innerHTML = x" },
  { name: "a DOM lookup (a scene id must never reach a selector)", re: /\b(?:querySelector(?:All)?|getElementById|getElementsBy\w+|closest|matches)\s*\(/, sample: 'root.querySelector("#" + id)' },
  { name: "an image", re: /<img\b|\bnew Image\b|\bbackgroundImage\b|\burl\((?!#)/, sample: "<img src={x} />" },
  { name: "a link", re: /<a[\s>]|\bhref\s*=|\bopenExternal\b|\bwindow\.open\b|\blocation\s*[.=]/, sample: '<a href="x">' },
  { name: "a frame or embed", re: /<(?:iframe|object|embed|webview|script)\b/i, sample: "<iframe />" },
  { name: "a style built as a string", re: /\bcssText\b|setAttribute\(\s*["']style|\bstyle\s*=\s*\{\s*`|\bstyle\s*=\s*["'{]\s*\w+\s*\+/, sample: "style={`color:${x}`}" },
  { name: "Markdown", re: /from\s+["'][^"']*markdown[^"']*["']|\bMarkdown\b|\bagx-prose\b/i, sample: 'import { Markdown } from "../../lib/markdown.tsx"' },
  { name: "code from a string", re: /\beval\s*\(|\bnew Function\b|\bdocument\.write\b|\bsetTimeout\(\s*["'`]/, sample: 'eval("1")' },
  { name: "the canvas fetching anything itself", re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\b|\bEventSource\b/, sample: "fetch(url)" },
];

const violations = (src: string) => FORBIDDEN.filter((f) => f.re.test(strip(src))).map((f) => f.name);

describe("a live canvas's source", () => {
  for (const f of FILES) {
    test(`${f} has none of the forbidden constructs`, () => {
      expect(violations(sources.get(f)!)).toEqual([]);
    });
  }

  test("the view imports no Markdown module, directly", () => {
    const view = strip(sources.get("src/components/plugins/PluginCanvas.tsx")!);
    const imports = [...view.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(5);
    expect(imports.filter((i) => /markdown/i.test(i))).toEqual([]);
    // Nor the tree, which imports it: the canvas draws its own parts.
    expect(imports.filter((i) => /PluginTree/.test(i))).toEqual([]);
  });

  test("the motion file animates only transform and opacity", () => {
    const src = strip(sources.get("src/lib/canvasMotion.ts")!).replace(/\$\{[^}]*\}/g, "X");
    const literals = [...src.matchAll(/\{([^{}]*\b(?:opacity|transform)\s*:[^{}]*)\}/g)].map((m) => m[1]!);
    expect(literals.length).toBeGreaterThan(5);
    for (const body of literals) {
      const keys = [...body.replace(/"[^"]*"/g, '""').matchAll(/(\w+)\s*:/g)].map((m) => m[1]!);
      expect(keys.filter((k) => !["opacity", "transform", "offset"].includes(k))).toEqual([]);
    }
    expect(/dashoffset/i.test(src)).toBe(false);
  });

  for (const f of ["src/components/plugins/PluginCanvas.tsx", "src/components/plugins/CanvasBoard.tsx"] as const) {
    test(`${f} puts no scene text into a style: every tone, gap and curve is a table lookup`, () => {
      const view = strip(sources.get(f)!);
      // The tone tables are indexed by a value that went through toneOf.
      const lookups = [...view.matchAll(/TONE_(?:COLOR|INK)\[([^\]]+)\]/g)].map((m) => m[1]!);
      expect(lookups.length).toBeGreaterThan(2);
      expect(lookups.filter((k) => !/^(?:tone|toneOf\(.+\))$/.test(k))).toEqual([]);
      expect(/\bstyle=\{\{[^}]*\bn\.(?:label|text|title|value|hint|meta|badge|caption|prefix|unit)\b/.test(view)).toBe(false);
    });
  }

  test("the board's stylesheet moves only transform and opacity", () => {
    const css = strip(sources.get("src/components/plugins/canvasBoard.css")!);
    // Every keyframe step, and every transition's property list.
    const frames = [...css.matchAll(/@keyframes[^{]*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)].map((m) => m[1]!);
    expect(frames.length).toBeGreaterThan(2);
    for (const body of frames) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]!);
      expect(props.filter((p) => p !== "opacity" && p !== "transform")).toEqual([]);
    }
    const transitions = [...css.matchAll(/\btransition\s*:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    expect(transitions.length).toBeGreaterThan(4);
    for (const t of transitions) {
      if (t === "none") continue;
      for (const part of t.split(/,(?![^(]*\))/)) expect(["transform", "opacity"]).toContain(part.trim().split(/\s+/)[0]!);
    }
    expect(/transition-property|stroke-dashoffset|backdrop-filter/.test(css)).toBe(false);
  });
});

describe("what a scene can ask the person", () => {
  test("every question goes through the one that names the plugin, never the bare dialog", () => {
    const view = strip(sources.get("src/components/plugins/PluginCanvas.tsx")!);
    expect(view).toContain("askAs");
    expect([...view.matchAll(/(?<![.\w])ask\(/g)].length).toBe(1); // the wrapper itself
    expect(/ask:\s*askAs/.test(view)).toBe(true);
  });
});

describe("a sheet and a dock", () => {
  test("an id attribute in the sheet is made from useId, never from a scene's id", () => {
    const src = strip(sources.get("src/components/plugins/CanvasSheet.tsx")!);
    const ids = [...src.matchAll(/\bid=\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(2);
    // The hatch's clip id carries the scene id only after it has lost everything but letters and digits, behind the useId.
    for (const i of ids) expect(i).toMatch(/uid|clip/);
    expect(src).toMatch(/const clip = `\$\{uid\}-clip-\$\{hx\.id\.replace\(ID_RE, ""\)\}`/);
    expect(/\bid="/.test(src)).toBe(false);
  });

  test("the sheet puts no scene text into a style: a tone is a table lookup and the rest is a clamped number", () => {
    for (const f of ["src/components/plugins/CanvasSheet.tsx", "src/components/plugins/CanvasDock.tsx"] as const) {
      const src = strip(sources.get(f)!);
      const lookups = [...src.matchAll(/TONE_(?:COLOR|INK)\[([^\]]+)\]/g)].map((m) => m[1]!);
      expect(lookups.length, f).toBeGreaterThan(1);
      expect(lookups.filter((k) => !/^(?:tone(?: === "default" \? "(?:muted|default)" : tone)?|toneOf\(.+\))$/.test(k)), f).toEqual([]);
      expect(/\bstyle=\{\{[^}]*\bn\.(?:label|text|title|value|hint|unit|chip)\b/.test(src), f).toBe(false);
    }
  });

  test("a sheet is paint only: no animation, no transition, no filter, and the svg takes no pointer", () => {
    const css = strip(sources.get("src/components/plugins/canvasSheet.css")!);
    expect(/@keyframes|\banimation\b|\btransition\b|\bfilter\b|backdrop-filter|\bblur\(/.test(css)).toBe(false);
    expect(css).toMatch(/\.cv-svg\s*\{[^}]*pointer-events:\s*none/);
  });

  test("a fold is clamped where it becomes a height, and a hidden fold is inert", () => {
    const src = strip(sources.get("src/components/plugins/CanvasDock.tsx")!);
    expect(src).toMatch(/int\(n\.h, 160, 760/);
    expect(src).toMatch(/int\(n\.hNarrow, 160, 760/);
    expect(src).toContain('inert: ""');
  });

  test("the window draws a gated scene: the flash limiter is between the reducer and the view", () => {
    const view = strip(sources.get("src/components/plugins/PluginCanvas.tsx")!);
    expect(view).toMatch(/const drawn = useDrawnScene\(state\.scene, reduced\)/);
    expect(view).toMatch(/const scene = drawn;/);
  });
});

describe("the guard itself", () => {
  test("it sees every form it is meant to", () => {
    for (const f of FORBIDDEN) expect(f.re.test(f.sample), f.name).toBe(true);
  });

  test("a comment that names a forbidden thing is not a violation, and code that does is", () => {
    expect(violations("// no innerHTML here\n/* querySelector( ) */\nconst x = 1;")).toEqual([]);
    expect(violations("el.innerHTML = s;")).toContain("innerHTML and its kin");
    expect(violations('const u = "https://example.test/a";\nel.x = 1;')).toEqual([]);
  });
});
