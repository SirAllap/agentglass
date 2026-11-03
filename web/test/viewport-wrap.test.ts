/*
 * A header row is one non-wrapping flex line with shrink-0 controls, or it is a
 * row that wraps. Measured on the real app at CSS widths from 1440 down to 640:
 * the Git strip was squeezed to 97px of 791 with Stashes and Tidy behind an
 * invisible scroll, the Docker actions painted over their own filter and then
 * left the window, and the Agents lockup was drawn under its right-hand cluster.
 *
 * The fix is the same shape in all of them — `flex-wrap` on the row, and a row
 * that wraps has to be allowed to grow, because a fixed height clips the second
 * line it just made. Source-level because there is no renderer here.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
/** Comments out, so a mention of a shape in prose cannot pass for the shape. */
const code = (x: string) => x.split("\n").filter((l) => !/^\s*(\/?\*|\/\/|\*)/.test(l)).join("\n");

const git = code(read("../src/components/GitHeader.tsx"));
const docker = code(read("../src/components/docker/Header.tsx"));
const dockerCss = code(read("../src/components/docker/dockerCss.ts"));
const diffToolbar = code(read("../src/components/diff/DiffToolbar.tsx"));
const diffPage = code(read("../src/components/diff/DiffPage.tsx"));
const preset = code(read("../src/components/diff/PresetDiff.tsx"));
const agents = code(read("../src/components/agents/agentsView.css"));
const bench = code(read("../src/components/bench/FloatingBench.tsx"));

describe("a header row wraps instead of squeezing its controls", () => {
  it("Git: the strip's floor is its own tabs, so the row wraps before it is cut", () => {
    // The ten tabs need 778px at 1366x768 (x=328..1106); a hand-picked floor
    // (420) could still share the line with the actions and drew the strip cut
    // at Stashes. `fit-content` is that 778, so the row wraps before it clips.
    const strip = git.split("\n").find((l) => l.includes("ref={strip}")) ?? "";
    expect(strip).toContain("min-w-[fit-content]");
    expect(strip).not.toMatch(/min-w-\[[^\]]*\d+px/);
    expect(git).toContain("${viewHeaderClass} flex-wrap gap-y-1.5");
    expect(git).toMatch(/height: "auto", minHeight: VIEW_HEADER_H, maxHeight: "none"/);
  });

  it("Docker: the actions wrap under the scope, and the row grows", () => {
    expect(docker).toContain("${viewHeaderClass} dk-hdr flex-wrap");
    expect(docker).toMatch(/height: "auto", minHeight: VIEW_HEADER_H, maxHeight: "none"/);
  });

  it("Docker: a segmented choice keeps its options on one line, so the row does the wrapping", () => {
    expect(dockerCss).toContain(".dk-hdr .agx-seg{flex-wrap:nowrap}");
  });

  it("Diff: the shared toolbar wraps, and both rows it sits in grow", () => {
    expect(diffToolbar).toContain("flex flex-wrap items-center gap-1.5 gap-y-1");
    expect(diffPage).toContain("shrink-0 flex flex-wrap items-center gap-1.5 gap-y-1 px-3 py-1.5");
    expect(diffPage).toContain("minHeight: 44");
    expect(preset).toContain("flex flex-wrap items-center gap-3 gap-y-1.5 px-4 py-1.5");
  });

  it("Agents: the lockup shrinks and the actions take their own line", () => {
    expect(agents).toMatch(/\.agv \.head \{[^}]*flex-wrap: wrap/);
    expect(agents).toContain(".agv .head > :first-child { min-width: 0; }");
    expect(agents).toMatch(/\.agv \.seg2 button \{[^}]*white-space: nowrap/);
  });
});

describe("the floating bench button stays inside the window", () => {
  it("its place is clamped to the window, not a bare percentage", () => {
    expect(bench).toContain("clamp(${FAB_HALF + 4}px, ${st.fab.x}%");
    expect(bench).toContain("clamp(${FAB_HALF + 4}px, ${st.fab.y}%");
    expect(bench).not.toMatch(/left: `\$\{st\.fab\.x\}%`/);
  });
});
