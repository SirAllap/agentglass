/*
 * The console is part of the Docker frame, not of a section: the same bar sits
 * under every section, and a shell opened in one keeps its session when you
 * open another. No DOM under `bun test`, so this asserts the source.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../src");
const DOCKER = join(SRC, "components/docker");
const panel = await Bun.file(join(SRC, "components/DockerPanel.tsx")).text();
const dock = await Bun.file(join(DOCKER, "ConsoleDock.tsx")).text();
const SECTIONS = ["ContainersList.tsx", "SplitList.tsx", "Detail.tsx", "Images.tsx", "Volumes.tsx", "Networks.tsx", "Disk.tsx"];
const sections = await Promise.all(SECTIONS.map(async (f) => [f, await Bun.file(join(DOCKER, f)).text()] as const));

describe("the Docker console belongs to the frame", () => {
  test("the frame mounts it once, below the section row", () => {
    expect((panel.match(/<ConsoleDock\b/g) ?? []).length).toBe(1);
    // The strip is drawn by the dock, so the frame cannot mount a second one.
    expect(panel).not.toContain("<ConsoleStrip");
    expect(dock).toContain("<ConsoleStrip");
    // A sibling of the row and not a child of one section's branch.
    expect(panel.indexOf("<ConsoleDock")).toBeGreaterThan(panel.indexOf("<Navigator"));
    expect(panel.indexOf("<ConsoleDock")).toBeGreaterThan(panel.indexOf("const lead = ("));
  });

  test("the mount is not gated on the current section", () => {
    const at = panel.indexOf("<ConsoleDock");
    expect(panel.slice(Math.max(0, at - 240), at)).not.toMatch(/view ===|section ===|view !==|section !==/);
  });

  test("no section mounts or drives a console of its own", () => {
    const own = sections.filter(([, text]) => /ConsoleStrip|ConsoleDock|runInConsole|docked under the view/.test(text)).map(([f]) => f);
    expect(own).toEqual([]);
  });

  test("the bar's sentence is written in one file only", async () => {
    const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
    const texts = await Promise.all(files.map(async (f) => [f, await Bun.file(join(SRC, f)).text()] as const));
    expect(texts.filter(([, text]) => text.includes("docked under the view")).map(([f]) => f)).toEqual(["components/docker/ConsoleDock.tsx"]);
  });
});
