/*
 * What a plugin's review notes do to the board: the chip a card draws, the
 * "Not ready" chip, and the opt-in gate that files a pull request into Blocked.
 * The one guarantee that matters most is the default: with the setting off the
 * board is the one it was before the setting existed.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal";
import { board, fileInLane } from "../src/lib/prLanes.ts";
import { blockingOpen, chipFor, countsLine, gateFacts, gateReason, notReadyChip } from "../src/lib/prNotesChip.ts";
import type { PrSummary } from "../../shared/types.ts";
import type { PrNotesSummary } from "../../shared/pluginUi.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);
beforeEach(() => store.clear());

const NOW = 1_800_000_000_000;
const sum = (o: Omit<Partial<PrNotesSummary>, "open"> & { open?: Partial<PrNotesSummary["open"]> } = {}): PrNotesSummary => ({
  repo: "acme/orbit", number: 1042, resolved: 0, dismissed: 0, lastReviewAt: NOW - 5 * 60_000, plugins: ["acme-review"],
  reviewedSha: "1111111", headSha: "1111111", stale: false,
  ...o, open: { critical: 0, high: 0, medium: 0, low: 0, info: 0, ...o.open },
});

/** An approved, green pull request: what lands in "Green, ready to land". */
const green = (o: Partial<PrSummary> = {}): PrSummary => ({
  number: 1042, title: "t", author: "someone", state: "OPEN", isDraft: false, headRefName: "h", baseRefName: "main", url: "", updatedAt: "",
  reviewDecision: "APPROVED", additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
  checks: { total: 14, success: 14, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] },
  ...o,
} as unknown as PrSummary);
const MINE = { mine: true, asked: false };

describe("the chip a card draws", () => {
  it("says the worst open severity and how many, tinted by it", () => {
    expect(chipFor(sum({ open: { critical: 2, medium: 1 } }), NOW)).toMatchObject({ text: "2 critical open", tone: "error" });
    expect(chipFor(sum({ open: { high: 1, low: 4 } }), NOW)).toMatchObject({ text: "1 high open", tone: "error" });
    expect(chipFor(sum({ open: { medium: 3 } }), NOW)).toMatchObject({ text: "3 medium open", tone: "warning" });
    expect(chipFor(sum({ open: { low: 1 } }), NOW)).toMatchObject({ text: "1 low open", tone: "warning" });
    expect(chipFor(sum({ open: { info: 2 } }), NOW)).toMatchObject({ text: "2 info open", tone: "dim" });
  });

  it("a review of the current head with nothing open is clean, resolved ones included", () => {
    expect(chipFor(sum(), NOW)).toMatchObject({ text: "reviewed · clean", tone: "ok" });
    expect(chipFor(sum({ resolved: 3, dismissed: 1 }), NOW)).toMatchObject({ text: "reviewed · clean", tone: "ok" });
  });

  it("a head that moved is a stale review, whatever was open", () => {
    expect(chipFor(sum({ stale: true, open: { critical: 2 } }), NOW)).toMatchObject({ text: "stale review", tone: "dim" });
    expect(chipFor(sum({ stale: true }), NOW)?.title).toContain("Review again");
  });

  it("an unknown head is neither stale nor clean-by-assumption: the counts speak", () => {
    expect(chipFor(sum({ stale: null, open: { high: 2 } }), NOW)?.text).toBe("2 high open");
    expect(chipFor(sum({ stale: null }), NOW)?.text).toBe("reviewed · clean");
  });

  it("nothing from a plugin is no chip at all", () => {
    expect(chipFor(undefined, NOW)).toBeNull();
    expect(chipFor(sum({ lastReviewAt: null, plugins: [] }), NOW)).toBeNull();
  });

  it("the tooltip carries every count, the time and the plugin", () => {
    const t = chipFor(sum({ open: { critical: 2, medium: 1 }, resolved: 3 }), NOW)!.title;
    expect(t).toContain("2 critical, 1 medium open");
    expect(t).toContain("3 resolved");
    expect(t).toContain("reviewed 5m ago");
    expect(t).toContain("acme-review");
    expect(countsLine(sum())).toBe("nothing open");
  });
});

describe("only a review of the current head can hold a pull request", () => {
  it("counts critical and high of a non-stale review", () => {
    expect(blockingOpen(sum({ open: { critical: 1, high: 2, medium: 9 } }))).toEqual({ critical: 1, high: 2, n: 3 });
    expect(notReadyChip(sum({ open: { critical: 1, high: 2 } }))?.text).toBe("Not ready: 3 open");
  });
  it("medium, low and info never hold one", () => {
    expect(notReadyChip(sum({ open: { medium: 5, low: 5, info: 5 } }))).toBeNull();
    expect(gateFacts(sum({ open: { medium: 5 } }))).toBeUndefined();
  });
  it("a stale review does not, and neither does one whose head nobody knows", () => {
    expect(gateFacts(sum({ stale: true, open: { critical: 4 } }))).toBeUndefined();
    expect(gateFacts(sum({ stale: null, open: { critical: 4 } }))).toBeUndefined();
    expect(notReadyChip(sum({ stale: true, open: { critical: 4 } }))).toBeNull();
    expect(gateFacts(undefined)).toBeUndefined();
  });
  it("the reason names what is open", () => {
    expect(gateReason({ n: 1, critical: 1, high: 0 })).toBe("1 open critical finding from local-review");
    expect(gateReason({ n: 3, critical: 3, high: 0 })).toBe("3 open critical findings from local-review");
    expect(gateReason({ n: 3, critical: 1, high: 2 })).toBe("3 open critical or high findings from local-review");
  });
});

describe("the gate in the lanes", () => {
  const held = gateFacts(sum({ open: { critical: 2 } }));

  it("off (no gate passed): a green approved pull request lands, whatever the notes say", () => {
    expect(fileInLane(green(), MINE).lane).toBe("land");
    expect(fileInLane(green(), MINE, undefined, undefined).lane).toBe("land");
  });

  it("on: it leaves green for Blocked with the reason line", () => {
    const f = fileInLane(green(), MINE, undefined, held);
    expect(f.lane).toBe("blocked");
    expect(f.reason).toBe("2 open critical findings from local-review");
  });

  it("on, but the findings were resolved or the review went stale: back to green", () => {
    expect(fileInLane(green(), MINE, undefined, gateFacts(sum({ open: {}, resolved: 2 }))).lane).toBe("land");
    expect(fileInLane(green(), MINE, undefined, gateFacts(sum({ stale: true, open: { critical: 2 } }))).lane).toBe("land");
  });

  it("only takes cards out of green: a card that was not about to land stays where it was", () => {
    const red = green({ checks: { total: 14, success: 13, failure: 1, skipped: 0, pending: 0, allDone: true, verdict: "red", failing: [] } } as never);
    expect(fileInLane(red, MINE, undefined, held)).toEqual(fileInLane(red, MINE));
    const asked = { mine: false, asked: true };
    expect(fileInLane(green(), asked, undefined, held)).toEqual(fileInLane(green(), asked));
    const notApproved = green({ reviewDecision: null } as never);
    expect(fileInLane(notApproved, MINE, undefined, held)).toEqual(fileInLane(notApproved, MINE));
  });

  it("the board with no gate function is the board it always was, card for card", () => {
    const prs = [1, 2, 3, 4, 5, 6].map((n) => green({ number: n, isDraft: n === 4, reviewDecision: n === 5 ? null : "APPROVED" } as never));
    const stake = (p: PrSummary) => ({ mine: p.number % 2 === 0, asked: p.number === 3 });
    const plain = board(prs, stake);
    const never = board(prs, stake, undefined, undefined, () => undefined);
    const laneOf = (m: ReturnType<typeof board>) => JSON.stringify([...m].map(([id, cards]) => [id, cards.map((c) => [c.number, c.filed])]));
    expect(laneOf(never)).toBe(laneOf(plain));
  });

  it("the board with the gate moves exactly the held cards and nothing else", () => {
    const prs = [1, 2, 3].map((n) => green({ number: n } as never));
    const stake = () => MINE;
    const gate = (p: PrSummary) => (p.number === 2 ? held : undefined);
    const on = board(prs, stake, undefined, undefined, gate);
    expect(on.get("land")!.map((c) => c.number)).toEqual([1, 3]);
    expect(on.get("blocked")!.map((c) => c.number)).toEqual([2]);
    // resolving the findings: the same call with no facts puts it back
    const back = board(prs, stake, undefined, undefined, () => undefined);
    expect(back.get("land")!.map((c) => c.number)).toEqual([1, 2, 3]);
  });
});

describe("the setting", () => {
  const load = async () => (await import(`../src/lib/reviewGatePref.ts?t=${Math.random()}`)) as typeof import("../src/lib/reviewGatePref.ts");

  it("is OFF by default and the default is not written to storage", async () => {
    const m = await load();
    expect(m.REVIEW_GATE_DEFAULT).toBe(false);
    expect(m.reviewGateOn()).toBe(false);
    m.setReviewGate(true);
    expect(m.reviewGateOn()).toBe(true);
    expect(store.size).toBe(1);
    m.setReviewGate(false);
    expect(m.reviewGateOn()).toBe(false);
    expect(store.size).toBe(0);
  });

  it("tells whoever draws the board when it flips", async () => {
    const m = await load();
    let n = 0;
    const off = m.onReviewGate(() => n++);
    m.setReviewGate(true);
    off();
    m.setReviewGate(false);
    expect(n).toBe(1);
  });
});

describe("the board's source", async () => {
  const board_ = await Bun.file(import.meta.dir + "/../src/components/TriageBoard.tsx").text();
  const panel = await Bun.file(import.meta.dir + "/../src/components/PrPanel.tsx").text();
  const registry = await Bun.file(import.meta.dir + "/../src/lib/settingsRegistry.ts").text();
  const actions = await Bun.file(import.meta.dir + "/../src/components/plugins/PluginPrActions.tsx").text();
  const noComments = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("hands the lanes a gate only while the setting is on", () => {
    expect(noComments(board_)).toContain("gateOn ? (p) => gateFacts(summaries.get(p.number)) : undefined");
  });

  it("asks for the summary once for the board, from the server's own store, never per card", () => {
    const code = noComments(board_);
    const at = code.indexOf("function CardView(");
    expect(code.slice(at)).not.toContain("loadNotesSummary(");
    expect(code.match(/loadNotesSummary\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/setInterval/);
  });

  it("the chip opens the pull request on its notes, and the panel knows how", () => {
    expect(board_).toContain('onOpenNotes={() => onOpen(p.number, "notes")}');
    expect(panel).toContain('if (to === "notes") { setConvWho("local"); setTab("conversation"); }');
    expect(panel).toContain("repoSlug={repo.nameWithOwner}");
  });

  it("the header reads the same summary and passes the head it is on", () => {
    expect(panel.match(/headSha=\{d\.headSha\}/g)).toHaveLength(2);
    expect(noComments(actions)).toContain("notReadyChip(summariesOf(repo).get(number))");
  });

  it("the setting has no def, so an agent cannot reach it, and its row says why", async () => {
    expect(registry).not.toContain("reviewGate");
    const modal = await Bun.file(import.meta.dir + "/../src/components/SettingsModal.tsx").text();
    const at = modal.indexOf('label="Review findings block merge-ready pull requests"');
    expect(at).toBeGreaterThan(0);
    expect(modal.slice(at - 400, at)).toContain("agentNever=");
  });
});
