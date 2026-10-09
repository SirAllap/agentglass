/*
 * The settings page of the docs lists what the code has.
 *
 * A pref added without its row in docs/CONFIG.md is invisible to anybody who
 * reads the docs rather than the settings screen, and a default quoted from
 * memory drifts the first time the code changes it. So this walks the real
 * defaults and demands each key and its default in the table.
 */
import { describe, expect, test } from "bun:test";
import { defaultPrefs } from "../src/clickupPrefs.ts";

const docs = await Bun.file(new URL("../../docs/CONFIG.md", import.meta.url)).text();
const table = docs.slice(docs.indexOf("## ClickUp workflow settings"), docs.indexOf("## API"));

/** Every leaf of the prefs object as `a.b`, with its default. */
function leaves(o: Record<string, unknown>, at = ""): [string, unknown][] {
  return Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? leaves(v as Record<string, unknown>, `${at}${k}.`) : [[`${at}${k}`, v] as [string, unknown]]);
}

/** How the table writes a default: `false`, `[]`, empty, or the pattern source. */
function written(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.map((x) => `\`${x}\``).join(", ") : "`[]`";
  if (v === "") return "empty";
  if (typeof v === "string") return `\`${v.replaceAll("|", "\\|")}\``;
  return `\`${String(v)}\``;
}

describe("docs/CONFIG.md lists every ClickUp setting with its real default", () => {
  for (const [key, def] of leaves(defaultPrefs() as unknown as Record<string, unknown>)) {
    test(key, () => {
      const row = table.split("\n").find((l) => l.startsWith(`| \`${key}\` |`));
      expect(row, `no row for ${key}`).not.toBeUndefined();
      const cells = row!.replaceAll("\\|", "\u0001").split("|").map((c) => c.replaceAll("\u0001", "\\|").trim());
      expect(cells[2]).toBe(written(def));
    });
  }
});

describe("the card source is offered only where there is a token", () => {
  test("it declares itself connected on the credential, and the loop and the list honour that", async () => {
    const src = await Bun.file(new URL("../src/understudy-sources-work.ts", import.meta.url)).text();
    const from = src.indexOf('id: "clickup"');
    expect(src.slice(from, from + 400)).toContain('connected: () => hasCredential("clickup")');
    const work = await Bun.file(new URL("../src/understudy-work.ts", import.meta.url)).text();
    expect(work).toContain("s.connected?.() ?? true");
    expect(work).toContain("if (!(s.connected?.() ?? true)) continue;");
  });
});
