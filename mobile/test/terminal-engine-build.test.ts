/*
 * The terminal engine, as the build script compiles it, must keep a variable it
 * assigns declared.
 *
 * xterm's `requestMode` (DECRQM, the "does your terminal support mode N?"
 * query) opens with `let r; (enum IIFE)(r ||= {})`. With the options the build
 * used to have, esbuild lowered that to `(…)(void 0||(i={}))` and dropped the
 * `let`. A class body is strict, so the first DECRQM threw a ReferenceError,
 * xterm's write buffer never advanced past that chunk, and the phone's terminal
 * stayed black with a cursor. tmux 3.8 opens every attach with `ESC[?2026$p`,
 * so every pane of a computer whose tmux server was started on 3.8 came up black.
 *
 * Nothing here runs the bundle: it needs a DOM, and a bug of this shape is
 * visible in the text. If xterm changes the shape of that method the regex
 * below stops matching and this fails on purpose — re-measure, do not loosen.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { ENGINE_ESBUILD } from "../scripts/engine-esbuild.mjs";

const require = createRequire(import.meta.url);
const installed = (() => { try { return existsSync(require.resolve("@xterm/xterm/package.json")) && !!require.resolve("esbuild"); } catch { return false; } })();

if (!installed) console.log("skipping terminal-engine-build.test.ts: needs mobile's npm dependencies — run `cd mobile && npm ci`");

describe.skipIf(!installed)("the engine bundle", () => {
  test("requestMode declares the variable its enum IIFE assigns", async () => {
    const esbuild = await import("esbuild");
    const built = await esbuild.build({
      ...ENGINE_ESBUILD,
      stdin: { contents: "import { Terminal } from '@xterm/xterm'; window.Terminal = Terminal", resolveDir: new URL("..", import.meta.url).pathname },
    } as import("esbuild").BuildOptions & { write: false });
    const js = built.outputFiles[0]!.text;

    // The DEFINITION, not the call sites that register it with the parser.
    const start = js.search(/requestMode\(\w+,\w+\)\{/);
    const end = js.indexOf("PERMANENTLY_RESET", start);
    expect(start, "requestMode is no longer defined in the bundle").toBeGreaterThan(-1);
    expect(end, "requestMode no longer builds its status enum").toBeGreaterThan(start);

    const head = js.slice(start, end + 80);
    const arg = head.match(/\)\((?:void 0\|\|\((\w+)=\{\}\)|\w+\|\|\((\w+)=\{\}\))\)/);
    expect(arg, "the enum IIFE changed shape — re-measure before touching this test").not.toBeNull();
    const name = arg![1] ?? arg![2]!;
    expect(head, `\`${name}\` is assigned in requestMode and never declared`).toMatch(new RegExp(`let ${name}[;,]`));
  });
});
