/*
 * A pull request approved and green on the list, whose merge box says it
 * conflicts (GitHub's `mergeable` still UNKNOWN, git naming the files) and that
 * a required job never reported. The board must move the card the moment the
 * detail has concluded it, and keep it there.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { fileInLane } from "../../shared/prLanes.ts";
import { noteKnownBlock, withKnownBlock, onKnownBlock, __resetKnownBlock } from "../src/lib/prKnownBlock.ts";
import type { PrSummary } from "../../shared/types.ts";

const row = (o: Partial<PrSummary> = {}): PrSummary => ({
  number: 1042, title: "Add thing", author: "ada", state: "OPEN", isDraft: false,
  headRefName: "feat/thing", baseRefName: "main", url: "", updatedAt: "", reviewDecision: "APPROVED",
  mergeable: "UNKNOWN", headSha: "aaa111",
  additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
  checks: { total: 14, success: 14, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] },
  ...o,
} as unknown as PrSummary);
const MINE = { mine: true, asked: false };
const ROOT = "/work/orbit";

afterEach(() => __resetKnownBlock());

describe("the detail's findings reach the board", () => {
  it("without them the card is filed ready to land (the defect)", () => {
    expect(fileInLane(withKnownBlock(ROOT, row()), MINE).lane).toBe("land");
  });

  it("a conflict the detail found moves the card to blocked with the chip's data", () => {
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: true, requiredMissing: false });
    const p = withKnownBlock(ROOT, row());
    expect(p.mergeable).toBe("CONFLICTING");
    expect(fileInLane(p, MINE).lane).toBe("blocked");
  });

  it("a required check that never reported moves it too", () => {
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: false, requiredMissing: true });
    const f = fileInLane(withKnownBlock(ROOT, row()), MINE);
    expect(f.lane).toBe("blocked");
    expect(f.reason).toContain("required check never reported");
  });

  it("the board is told, once, and a repeat of the same finding is silent", () => {
    let n = 0;
    const off = onKnownBlock(() => n++);
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: true, requiredMissing: false });
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: true, requiredMissing: false });
    off();
    expect(n).toBe(1);
  });

  it("a push changes the head and the note stops applying", () => {
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: true, requiredMissing: true });
    expect(withKnownBlock(ROOT, row({ headSha: "bbb222" })).mergeable).toBe("UNKNOWN");
  });

  it("the detail seeing it resolved lifts it", () => {
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: true, requiredMissing: false });
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: false, requiredMissing: false });
    expect(fileInLane(withKnownBlock(ROOT, row()), MINE).lane).toBe("land");
  });

  it("a list refresh that says UNKNOWN again does not undo it", () => {
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: true, requiredMissing: false });
    expect(withKnownBlock(ROOT, row({ mergeable: "UNKNOWN" })).mergeable).toBe("CONFLICTING");
  });
});

describe("board and detail decide alike (acme/orbit #1042)", () => {
  /* Real shape: approved, all checks green, CLEAN, 7 behind the base, commits after the approval. The list guessed a required check missing. */
  const stamped = () => row({ requiredMissing: true });

  it("the detail finding nothing blocking cancels the list's guess: Green, ready", () => {
    expect(fileInLane(withKnownBlock(ROOT, stamped()), MINE).lane).toBe("blocked");
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: false, requiredMissing: false, behindBlocks: false });
    expect(fileInLane(withKnownBlock(ROOT, stamped()), MINE).lane).toBe("land");
  });

  it("behind the base alone is a hint: still Green, ready", () => {
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: false, requiredMissing: false, behindBlocks: false });
    expect(fileInLane(withKnownBlock(ROOT, row()), MINE).lane).toBe("land");
  });

  it("behind with up-to-date required: not ready", () => {
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: false, requiredMissing: false, behindBlocks: true });
    const f = fileInLane(withKnownBlock(ROOT, row()), MINE);
    expect(f.lane).toBe("blocked");
    expect(f.reason).toContain("up to date");
  });

  it("a failing required check: Blocked", () => {
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: false, requiredMissing: false, behindBlocks: false });
    const red = row({ checks: { total: 14, success: 13, failure: 1, skipped: 0, pending: 0, allDone: true, verdict: "red", failing: [{ name: "unit", workflow: "CI", state: "failure", done: true }] } as never });
    expect(fileInLane(withKnownBlock(ROOT, red), MINE).lane).toBe("blocked");
  });

  it("the panel hands over the behind verdict", async () => {
    const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    expect(src).toContain("behindBlocks: blocksBehind");
  });
});

describe("a verdict is stored only once its inputs are loaded", () => {
  it("'nothing blocks' before the required contexts and merge state arrived does not cancel the list's guess", () => {
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: false, requiredMissing: false, behindBlocks: false, settled: false });
    expect(fileInLane(withKnownBlock(ROOT, row({ requiredMissing: true })), MINE).lane).toBe("blocked");
  });
  it("a block is stored even unsettled; a settled 'nothing' cancels", () => {
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: true, requiredMissing: false, settled: false });
    expect(withKnownBlock(ROOT, row()).mergeable).toBe("CONFLICTING");
    noteKnownBlock(ROOT, 1042, "aaa111", { conflicted: false, requiredMissing: false, behindBlocks: false, settled: true });
    expect(fileInLane(withKnownBlock(ROOT, row({ requiredMissing: true })), MINE).lane).toBe("land");
  });
  it("the panel passes what it loaded", async () => {
    const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    expect(src).toContain('settled: !!d.gate && d.mergeState !== "UNKNOWN"');
  });
});

describe("the panel keys the note by a head the detail really has", () => {
  it("uses headOfDetail, not d.headSha, which the detail payload never carries", async () => {
    /* Measured: the detail came back with no headSha, so a write keyed by it
       was dropped and the card never moved after the box said blocked. */
    const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    const at = src.indexOf("noteKnownBlock(root, d.number, ");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 80)).toContain("headOfDetail(d)");
  });
});
