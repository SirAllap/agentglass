/*
 * The Browser view is hidden with `visibility`, and a <webview> shown again can
 * stay unpainted on a real compositor. The shell repaints the guest on every
 * show and writes one line to browser-show.log; the renderer nudges the element
 * by 1px when nothing had painted. A rule about source is asserted against
 * source (there is no renderer here), and the log cap against the real module.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const load = createRequire(import.meta.url);
const log = load("../../electron/show-log.js") as {
  MAX_LINES: number;
  logPath: (env: Record<string, string>) => string;
  appendCapped: (file: string, line: string, max?: number) => void;
  showLine: (f: Record<string, unknown>) => string;
};
const dir = mkdtempSync(join(tmpdir(), "agx-show-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const main = await Bun.file(new URL("../../electron/main.js", import.meta.url)).text();
const preload = await Bun.file(new URL("../../electron/preload.js", import.meta.url)).text();
const panel = await Bun.file(new URL("../src/components/BrowserPanel.tsx", import.meta.url)).text();

/** The handler's own body, to its closing brace, comment lines stripped. */
function handler(src: string, head: string): string {
  const at = src.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf("{", at); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  }
  throw new Error("unclosed handler");
}

describe("browser-show.log", () => {
  test("keeps the newest 200 lines and never more", () => {
    const f = join(dir, "a", "browser-show.log");
    for (let i = 0; i < 250; i++) log.appendCapped(f, `n=${i}`);
    const lines = readFileSync(f, "utf8").trim().split("\n");
    expect(lines.length).toBe(200);
    expect(lines[0]).toBe("n=50");
    expect(lines.at(-1)).toBe("n=249");
  });
  test("a value with whitespace stays one line", () => {
    expect(log.showLine({ tab: "a b\nc", asleep: "no" })).toBe("tab=a_b_c asleep=no");
  });
  test("lives under the XDG cache", () => {
    expect(log.logPath({ XDG_CACHE_HOME: "/x" })).toBe("/x/agentglass/browser-show.log");
  });
});

describe("repaint on show", () => {
  test("the shell invalidates the guest, checks a capture, and logs", () => {
    const h = handler(main, 'ipcMain.handle("ag:browserShown"');
    expect(h).toContain("g.invalidate()");
    expect(h).toContain("capturePage");
    expect(h).toContain("Promise.race"); // a capture that never resolves must not eat the log line
    expect(h).toContain("showLog.appendCapped");
    expect(h).not.toMatch(/setInterval/); // no polling loop
  });
  test("the preload exposes it and the package ships the module", () => {
    expect(preload).toContain('ipcRenderer.invoke("ag:browserShown"');
    expect(readFileSync(new URL("../../electron/package.json", import.meta.url), "utf8")).toContain('"show-log.js"');
  });
  test("the view asks on every show, and only the view, and nudges by 1px", () => {
    const at = panel.indexOf("browserShown({");
    expect(at).toBeGreaterThan(-1);
    const eff = panel.slice(panel.lastIndexOf("useEffect(", at), panel.indexOf("[viewOn]);", at));
    expect(eff).toContain("!viewOn || scope");
    expect(eff).toContain("calc(100% - 1px)");
    expect(eff).toContain("r.painted");
  });
});
