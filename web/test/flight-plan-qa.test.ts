/*
 * Differences found driving the built Flight plan view in headless Chrome
 * against the approved mockup. Each is read from source (there is no renderer
 * here); the measured why is next to the test.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { filesWord, historyRows, type PlanDetail } from "../src/lib/flightPlan.ts";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url).pathname, "utf8");
const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
const css = read("src/components/flightPlan/flightPlanView.css");

describe("the No-go reason row", () => {
  /* `.note-in` sits in column 2 of the finding card's grid. The Go bar is a one-column grid: left at
     column 2 the input made an implicit second column, the poll overflowed 160 px sideways and
     scrolled its own labels out of view the moment the field took focus. */
  test("is reset to the one column of the Go bar", () => {
    expect(css).toMatch(/\.fpv \.gobar \.note-in \{[^}]*grid-column: auto/);
  });
});

describe("files read", () => {
  /* The history said "1 files read" for a plan whose only file was its own text, and the certificate
     said "Read these 0 files" for the same run: the plan is read too, and one is "file". */
  test("the count has a singular", () => {
    expect(filesWord(1)).toBe("1 file");
    expect(filesWord(0)).toBe("0 files");
  });
  test("a plan's row counts its text and says 1 file; a task's row counts none", () => {
    const cert = { files: [], mockups: [], findings: [], costUsd: 0, skipped: [] };
    const run = (moment: string) => ({ id: "pf_" + moment, root: "/p/orbit", moment, state: "done", createdAt: 1, input: {}, certificate: cert, error: null, taskId: null });
    const plan = { id: "fp_1", root: "/p/orbit", title: "t", size: "S", state: "go", updatedAt: 1, decision: { at: 1 }, mockups: [] };
    const rows = historyRows([{ plan, run: run("before-launch") } as unknown as PlanDetail], [run("task-done") as never]);
    expect(rows.find((r) => r.planId)?.sub).toBe("orbit · S · 1 file read");
    expect(rows.find((r) => !r.planId)?.sub).toContain("0 files");
  });
  test("the certificate counts the plan's text only when told it is a plan's run", () => {
    const g = read("src/components/flightPlan/GoPoll.tsx"), plans = read("src/components/flightPlan/PlansTab.tsx");
    expect(g).toContain("files.length + (withPlan ? 1 : 0)");
    expect(plans).toMatch(/<Certificate run=\{sel\.run\} cap=\{cap\} withPlan \/>/);
  });
});

describe("the running card", () => {
  /* A running plan review said "Reading 0 files." : the run's input lists the files beside the plan,
     and the plan text itself, with its mockups, is what is being read. */
  test("counts the plan and its mockups, with the singular", () => {
    const f = read("src/components/flightPlan/FindingsCard.tsx");
    expect(f).toContain("filesWord(files + plan.mockups.length + 1)");
    expect(f).not.toContain("Reading {files}");
  });
});

describe("the open plan's title", () => {
  /* Measured on the built view against the mockup: the title rendered at weight 400 (the app resets
     headings) where the design is 700. Every other size and weight on the view matched to a pixel. */
  test("is bold", () => {
    expect(css).toMatch(/\.fpv \.ttl h4 \{[^}]*font-weight: 700/);
  });
});

describe("the empty states' heading", () => {
  /* Same reset as the plan title: "No flight plans yet" and "Have a fresh pair of eyes..." rendered
     at 400 where the design's headings are 700. */
  test("is bold", () => {
    expect(css).toMatch(/\.fpv \.empty h4 \{[^}]*font-weight: 700/);
  });
});

describe("a server that went away", () => {
  /* Nothing polls while the view is idle, so killing the server left the last list on screen with no
     word. The view now reads again when the window is back, and says so when that read fails. */
  test("reads again on focus and says when it cannot", () => {
    expect(code(read("src/components/flightPlan/useFlightPlan.ts"))).toContain('window.addEventListener("focus", back)');
    const v = code(read("src/components/flightPlan/FlightPlanView.tsx"));
    expect(v).toContain("d.error && d.details !== null");
    expect(v).toContain('role="alert"');
  });
});

describe("the loading state", () => {
  /* The first read drew one line of grey text; the mockup's "in progress" state is shimmering bars in
     the shape of a flight row, and a failed first read says so in the tab's own area. */
  test("is rows of skeleton bars, and an error says so in the tab", () => {
    const l = code(read("src/components/flightPlan/FlightList.tsx"));
    expect(l).toContain('aria-busy="true"');
    expect(l).toContain('className="skel"');
    const v = code(read("src/components/flightPlan/FlightPlanView.tsx"));
    expect(v).toContain("d.details === null && d.error");
    expect(v).toContain('role="alert"');
    expect(v).not.toContain('className="say"');
  });
});

describe("Go on a short window", () => {
  /* At 1100x520 the poll sits under the plan in a 200 px band and its Go button was below the fold.
     The Go bar sticks to the bottom of that band, as the mockup's sticky footer does; the poll clips
     instead of scrolling so the bar can stick to the column's scroll, not to the poll. */
  test("the Go bar sticks to the bottom and the poll clips rather than scrolls", () => {
    expect(css).toMatch(/\.fpv \.gobar \{[^}]*position: sticky; bottom: 0/);
    expect(css).toMatch(/\.fpv \.poll \{[^}]*overflow: clip/);
  });
});
