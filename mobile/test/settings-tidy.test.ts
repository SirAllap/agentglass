/*
 * Settings, read as source (there is no renderer in this project): the segmented
 * choices are 48 tall, Forget lives in the computer's sheet behind its own
 * confirmation, and the key bar's move buttons are as wide as they are tall.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string): string => readFileSync(join(import.meta.dir, "..", p), "utf8");
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
const settings = strip(read("app/(tabs)/settings.tsx"));

/** The body of `function name(` up to its own closing brace at column 0. */
function fn(src: string, name: string): string {
  // `Pick<V extends string>(` is generic, so the paren is not always next.
  const at = src.search(new RegExp(`function ${name}[(<]`));
  expect(at, name).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf("\n}\n", at));
}

describe("Settings", () => {
  test("a segmented choice is at least 48 tall", () => {
    const pick = fn(settings, "Pick");
    expect(pick).toContain("minHeight: TAP");
    expect(pick).not.toMatch(/minHeight: (3\d|4[0-7])\b/);
  });

  test("Forget is in the computer's sheet, asks there, and is not at the page's foot", () => {
    const sheet = fn(settings, "ComputerSheet");
    expect(sheet).toContain("Forget this computer…");
    expect(sheet).toContain("Keep it");
    expect(sheet).not.toContain("Alert.alert");
    const screen = settings.slice(settings.indexOf("export default function SettingsScreen"));
    expect(screen).not.toContain('label="Forget this computer');
    expect(screen).not.toMatch(/Alert\.alert\(\s*"Forget this computer/);
  });
});

describe("Key bar", () => {
  test("the move buttons are 48 wide", () => {
    const arrow = fn(strip(read("app/terminal-settings.tsx")), "Arrow");
    expect(arrow).toContain("width: TAP");
    expect(arrow).not.toContain("width: 40");
  });
});
