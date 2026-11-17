import { expect, test } from "bun:test";
import { Glob } from "bun";

/* A personOnly setting is one no agent may change, not even by asking. With no
 * control in the window it is a dead switch: nobody can change it. So every one
 * names a place in web/src. A known gap is listed here with its reason, never
 * skipped silently; the list only shrinks. */
const GAPS: Record<string, string> = {};

const classes = await Bun.file(new URL("../../shared/settingClass.ts", import.meta.url)).text();
const ids = [...classes.matchAll(/^\s*"([a-zA-Z.]+)":\s*\{\s*class:\s*"personOnly"/gm)].map((m) => m[1]!);

const sources: string[] = [];
for await (const f of new Glob("**/*.{ts,tsx}").scan({ cwd: new URL("../src", import.meta.url).pathname, absolute: true })) {
  sources.push(await Bun.file(f).text());
}
const web = sources.join("\n");

test("the scan finds the personOnly settings", () => {
  expect(ids.length).toBeGreaterThan(5);
  expect(ids).toContain("flow.delegationGuard");
});

test("every personOnly setting has a control in the window", () => {
  const missing = ids.filter((id) => !GAPS[id] && !web.includes(`"${id}"`));
  expect(missing).toEqual([]);
});

test("a listed gap is still a gap", () => {
  const stale = Object.keys(GAPS).filter((id) => web.includes(`"${id}"`));
  expect(stale).toEqual([]);
});
