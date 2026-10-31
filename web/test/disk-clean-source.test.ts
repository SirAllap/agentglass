/*
 * Source guards on the disk cleanup block: what a press can send, how a
 * confirmation is put away, and that the machine panel mounts the block and the
 * badge. Read as text, like the other guards in this folder; the ceiling is the
 * same (a call reached through a computed name is not seen).
 *
 * The block's decisions are disk-clean.test.ts; the staged plan's are
 * disk-stage.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "src");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const block = code(read("components/DiskClean.tsx"));
const panel = code(read("components/MachinePanel.tsx"));
const resources = code(read("components/machine/Resources.tsx"));

/** The text of `async function`-style arrow `const run = async (...) => {` up to its closing brace at the same indent. */
function body(src: string, start: string): string {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`DiskClean.tsx no longer has ${JSON.stringify(start)} where this guard looks`);
  const indent = /^ */.exec(src.slice(src.lastIndexOf("\n", a) + 1))![0];
  const end = src.indexOf(`\n${indent}};`, a);
  if (end < 0) throw new Error(`no closing brace for ${JSON.stringify(start)}`);
  return src.slice(a, end);
}

describe("the lists keep to the tab's one scroll", () => {
  // The groups grow to their rows and the Resources column scrolls as a whole; a list with its own scroller would nest one scroll in another.
  it("no list inside the block has a scroller or a height of its own", () => {
    expect(block).not.toMatch(/overflow-y-auto|maxHeight|overflowY/);
  });
  it("the block puts no scroller of its own around itself: the tab's scroller carries it", () => {
    expect(block).not.toMatch(/<section[^>]*overflow/);
  });
});

describe("what a press sends", () => {
  it("the clean call carries line ids and the scan they came from, and no dry-run flag that could turn a click into a no-op", () => {
    const calls = [...block.matchAll(/api\.machineDiskCleanRun\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls).toEqual(["ids, report?.at"]);
  });
  it("the block never builds a path or a shell argument of its own", () => {
    expect(block).not.toMatch(/\.target\b|\.path\b|\.root\b/);
    expect(block).not.toMatch(/rm -|docker |prune/);
  });
  it("the scan call is the one a person asked for, and the cached one for a staged plan", () => {
    const calls = [...block.matchAll(/scan\((true|false)\)/g)].map((m) => m[1]);
    expect(calls.sort()).toEqual(["false", "true"]);
  });
  it("every press that removes goes through run(), which puts the confirmation away first", () => {
    const run = body(block, "const run = async");
    expect(run.indexOf("setArmed(null)")).toBeGreaterThan(-1);
    expect(run.indexOf("setArmed(null)")).toBeLessThan(run.indexOf("api.machineDiskCleanRun"));
    const presses = [...block.matchAll(/void run\(([^)]*)\)/g)].map((m) => m[1]);
    expect(presses.sort()).toEqual(["[l.id]", "target.ids"]);
  });
});

describe("arm, then confirm", () => {
  it("the first press only arms: the plain Clean button calls setArmed, never run", () => {
    expect(block).toMatch(/onClick=\{\(\) => setArmed\(staged \? "staged" : "all"\)\}/);
    expect(block).toMatch(/onClick=\{onArm\}/);
  });
  it("Escape disarms, and stops the key so the panel does not close behind it", () => {
    const a = block.indexOf("const h = (e: KeyboardEvent)");
    expect(a).toBeGreaterThan(-1);
    const h = block.slice(a, block.indexOf("document.addEventListener", a));
    expect(h).toContain('e.key === "Escape"');
    expect(h).toContain("e.stopPropagation()");
    expect(h).toContain("setArmed(null)");
  });
  it("the listener only exists while something is armed", () => {
    expect(block).toMatch(/if \(armed === null\) return;[\s\S]{0,200}document\.addEventListener\("keydown", h\)[\s\S]{0,120}removeEventListener\("keydown", h\)/);
  });
});

describe("a plan an agent staged", () => {
  it("is copied into state and the mailbox cleared, and holds the confirm button like every prepared dialog", () => {
    expect(block).toContain("planDiskStage(staged, report.lines)");
    expect(block).toContain("clearDiskStage()");
    expect(block).toContain("useStageHold(staged !== null, staged?.n)");
    expect(block).toContain("preparedLine(staged.by)");
    expect(block).toMatch(/disabled=\{staged !== null && hold\}/);
  });
  it("staging walks nothing: with no scan yet it asks for the cached one", () => {
    expect(block).toMatch(/else if \(needsStageScan\(req, triedFor\.current, scanning\)\) \{ triedFor\.current = req\.n; void scan\(false\); \}/);
  });
});

describe("the machine panel", () => {
  it("mounts the block inside the Resources scroller, after the left-behind list", () => {
    expect(resources.indexOf("<LeftBehind")).toBeGreaterThan(-1);
    expect(resources.indexOf("<DiskClean />")).toBeGreaterThan(resources.indexOf("<LeftBehind"));
  });
  it("puts one badge on the Resources tab, from the setting and what was last seen, with the sentence as its name", () => {
    expect(panel).toContain("const lowDisk = useLowDisk()");
    expect(panel).toContain("aria-label={lowDisk}");
    expect((panel.match(/>Low disk</g) ?? []).length).toBe(1);
  });
  it("the badge is quiet: no notification, no toast", () => {
    expect(read("lib/diskClean.ts")).not.toMatch(/notify|Notification|toast/i);
  });
  it("the machine tile feeds the badge before anyone scans", () => {
    expect(resources).toContain("publishMachineDisk(d.machine)");
    expect(read("lib/diskClean.ts")).toContain('publishDiskMounts("tile"');
  });
});
