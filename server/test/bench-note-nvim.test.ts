import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/bench.ts", import.meta.url)).text();

// An app restart killed nvim mid-edit; the note lived only in the swap file
// and the next open stopped on E325 over a file that did not exist.
describe("the note in Neovim survives a restart", () => {
  const start = src.indexOf("export function noteNvimArgv(");
  const body = src.slice(start, src.indexOf("\n}\n", start));

  test("creates the file before nvim opens it", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('writeFileSync(file, "", { flag: "a", mode: 0o600 });');
  });

  test("runs with no swap file and writes on every change", () => {
    expect(body).toContain('"-n"');
    expect(body).toContain("autocmd TextChanged,TextChangedI,InsertLeave <buffer> silent! update");
  });
});
