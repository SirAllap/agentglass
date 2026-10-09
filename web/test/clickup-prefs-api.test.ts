/*
 * The two calls the Settings block will use, and their demo twins.
 *
 * Source assertions, because there is no renderer here: the real calls must
 * reach `/clickup/prefs` (GET to read, POST to save), and the demo must answer
 * without a request, so a hosted demo never makes a ClickUp-shaped call.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const lines = src.split("\n");
const call = (name: string) => lines.filter((l) => l.trimStart().startsWith(`${name}:`));

describe("clickup prefs in api.ts", () => {
  test("the real calls read and write /clickup/prefs", () => {
    const [read] = call("clickupPrefs");
    expect(read).toContain('get<');
    expect(read).toContain('"/clickup/prefs"');
    const setter = lines.findIndex((l) => l.trimStart().startsWith("clickupSetPrefs:"));
    expect(lines.slice(setter, setter + 3).join("\n")).toContain('post<{ ok: boolean; error?: string; prefs?: ClickUpPrefs }>("/clickup/prefs", patch)');
  });

  test("each has a demo twin that makes no request", () => {
    for (const name of ["clickupPrefs", "clickupSetPrefs"]) {
      const both = call(name);
      expect(both, name).toHaveLength(2);
      expect(both[1], name).toContain("D<");
      expect(both[1], name).not.toContain("fetch");
      expect(both[1], name).not.toContain("get<");
      expect(both[1], name).not.toContain("post<");
    }
  });
});
