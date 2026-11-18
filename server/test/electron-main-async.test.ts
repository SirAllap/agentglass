/*
 * The Electron main process must not do sync file I/O on hot paths.
 * Source tests: comments stripped, each function sliced by its closing brace.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "..", "electron", "main.js"), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
const code = strip(src);

/** Text from `start` to its matching closing brace. */
function slice(from: string): string {
  const i = code.indexOf(from);
  if (i < 0) throw new Error(`missing ${from}`);
  let depth = 0;
  for (let j = code.indexOf("{", i); j < code.length; j++) {
    if (code[j] === "{") depth++;
    else if (code[j] === "}" && --depth === 0) return code.slice(i, j + 1);
  }
  throw new Error("unbalanced");
}

describe("electron main: no sync I/O on hot paths", () => {
  test("screenshot saves write async", () => {
    expect(code).not.toMatch(/writeFileSync\(file0?, img0?\.toPNG\(\)\)/);
    expect(code.match(/await fs\.promises\.writeFile\(file0?, img0?\.toPNG\(\)\)/g)?.length).toBe(3);
  });

  test("rotatingAppend only queues; the flush is async", () => {
    const fn = slice("function rotatingAppend(");
    expect(fn).not.toMatch(/Sync\(/);
    const flush = slice("async function flushLog(");
    expect(flush).not.toMatch(/(?:exists|stat|append|rename)Sync\(/);
    expect(flush).toContain("fs.promises.appendFile");
  });

  test("popup log shares the buffered writer", () => {
    expect(code).toContain('rotatingAppend(file, line, 100_000)');
    expect(code).not.toMatch(/statSync\(file\)\.size > 100_000/);
  });

  test("saveWindowState is async unless asked, and close asks", () => {
    const fn = slice("function saveWindowState(");
    expect(fn).toContain("fs.promises.writeFile(WINDOW_CFG");
    expect(fn).toContain("if (sync)");
    expect(code).toContain("saveWindowState(win, true)");
    expect(code).toContain("setTimeout(() => saveWindowState(win), 1000)");
  });

  test("the quit path flushes the buffered logs", () => {
    expect(code).toContain('app.on("will-quit", flushLogsSync)');
  });
});
