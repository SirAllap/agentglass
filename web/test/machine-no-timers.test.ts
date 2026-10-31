/*
 * The Machine dialog does not poll. Docker's lists come from the event feed, the
 * host's numbers (CPU, load, temperature: no event source) are read on open, on
 * window focus, on Refresh, and while the stats feed streams; git locks and the
 * disk scan are read on open and on request. A setInterval or a usePoll in any of
 * these files is exactly the shape that was removed (ports every 10 s, resources
 * every 2.5 s, left behind every 60 s, locks every 2.5 s), so its absence is the
 * thing worth pinning. One-shot setTimeouts (a look after a stop, a second sample)
 * are not timers that repeat and are allowed.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

const SRC = new URL("../src/", import.meta.url);
const code = (text: string) => text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const read = (rel: string) => Bun.file(new URL(rel, SRC)).text();
const offends = (text: string) => /\bsetInterval\s*\(|\busePoll\b|\bpollWhileLooking\b/.test(code(text));

const FILES = [
  "components/MachinePanel.tsx", "components/DiskClean.tsx",
  ...readdirSync(new URL("components/machine/", SRC)).map((f) => `components/machine/${f}`),
];

describe("the Machine dialog holds no repeating timer", () => {
  test("the guard sees the shapes it is looking for", () => {
    expect(offends("setInterval(load, 2500)")).toBe(true);
    expect(offends("usePoll(true, load, 10_000);")).toBe(true);
    expect(offends("pollWhileLooking(() => {}, 5)")).toBe(true);
    expect(offends("// usePoll was removed\nsetTimeout(load, 600)")).toBe(false);
  });

  test("it checks every file of the dialog, and there are several", () => {
    expect(FILES.length).toBeGreaterThan(8);
  });

  test.each(FILES)("%s", async (rel) => {
    expect(offends(await read(rel)), rel).toBe(false);
  });
});

describe("what each tab listens to instead", () => {
  test("Ports reads on open, on focus, and when Docker says containers or networks changed", async () => {
    const t = code(await read("components/machine/usePorts.ts"));
    expect(t).toContain("useRefreshOnFocus(true, load)");
    expect(t).toMatch(/useDockerLive\(true, \{[\s\S]*onChanged[\s\S]*"containers"[\s\S]*"networks"/);
  });

  test("Resources reads on focus and Refresh, and a stats sample may ask for one reading per gap", async () => {
    const t = code(await read("components/machine/Resources.tsx"));
    expect(t).toContain("useRefreshOnFocus(true, load)");
    expect(t).toMatch(/onStats: \(\) => \{ if \(resampleDue\(/);
  });

  test("Left behind and Locks read on focus; the disk scan only when asked", async () => {
    expect(code(await read("components/machine/LeftBehind.tsx"))).toContain("useRefreshOnFocus(true");
    expect(code(await read("components/machine/Locks.tsx"))).toContain("useRefreshOnFocus(true, load)");
    const dc = code(await read("components/DiskClean.tsx"));
    expect(dc).not.toContain("useRefreshOnFocus");
    expect([...dc.matchAll(/scan\((true|false)\)/g)].map((m) => m[1]).sort()).toEqual(["false", "true"]);
  });
});
