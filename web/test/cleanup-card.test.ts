// The agent's cleanup request: the lines the server writes survive the trip to
// the card, the card says what will go and how much, and anything else is the
// plain request. Names are invented.
import { describe, expect, test } from "bun:test";
import { cleanupCardLines, parseCleanupCard, CARD_ITEMS, type CardFacts } from "../../shared/cleanupCard.ts";
import { askedWord, cleanupCardView } from "../src/lib/cleanupCard.ts";
import type { SettingRequestView } from "../../shared/settingClass.ts";

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const facts: CardFacts = {
  pr: 322, title: "Retry queue", repo: "acme/orbit", slug: "ORBIT-1042", mergedAt: NOW - 2 * 86_400_000,
  items: [
    { kind: "docker-image", target: "acme-orbit:ORBIT-1042", group: "docker", bytes: 4_100_000_000 },
    { kind: "docker-container", target: "orbit-1042-web", group: "docker", bytes: 41_000_000 },
    { kind: "worktree", target: "/home/a/code/orbit-1042", group: "worktree", bytes: 1_600_000_000 },
    { kind: "branch", target: "feat/ORBIT-1042-retry-queue", group: "branch", bytes: 0 },
    { kind: "stash", target: "stash@{0} retry backoff wip", group: "stashes", bytes: 300_000 },
  ],
};
const req = (diff: string[], over: Partial<SettingRequestView> = {}): SettingRequestView =>
  ({ id: "sr_1", setting: "cleanup.run", label: "Clean up a merged pull request", who: "an agent calling itself \"orbit-worker\"", diff, at: NOW - 20_000, expires: NOW + 600_000, ...over });

describe("the lines", () => {
  test("round trip: totals of the whole plan, items in order, groups summed", () => {
    const c = parseCleanupCard(cleanupCardLines(facts))!;
    expect(c).toMatchObject({ pr: 322, title: "Retry queue", repo: "acme/orbit", slug: "ORBIT-1042", itemCount: 5, totalBytes: 5_741_300_000, mergedAt: facts.mergedAt });
    expect(c.items.map((i) => i.target)[4]).toBe("stash@{0} retry backoff wip");
    expect(c.groups.map((g) => [g.group, g.items, g.bytes])).toEqual([["docker", 2, 4_141_000_000], ["worktree", 1, 1_600_000_000], ["branch", 1, 0], ["stashes", 1, 300_000]]);
  });

  test("a long plan keeps its totals and says how many are not listed", () => {
    const many = { ...facts, items: Array.from({ length: CARD_ITEMS + 7 }, (_, i) => ({ kind: "evidence", target: `/e/${i}`, group: "evidence", bytes: 10 })) };
    const lines = cleanupCardLines(many);
    expect(lines.length).toBe(CARD_ITEMS + 2);
    const v = cleanupCardView(req(lines), NOW)!;
    expect(v.unlisted).toBe(7);
    expect(v.count).toBe(`will be freed, ${CARD_ITEMS + 7} items`);
  });

  test("lines nobody here wrote are not a cleanup card", () => {
    expect(parseCleanupCard(["clean up the local leftovers of #1 x", "worktree: /a"])).toBeNull();
    expect(cleanupCardView(req(["anything"]), NOW)).toBeNull();
    expect(cleanupCardView(req(cleanupCardLines(facts), { setting: "diff.layout" }), NOW)).toBeNull();
  });
});

describe("the card", () => {
  const v = cleanupCardView(req(cleanupCardLines(facts)), NOW)!;

  test("says who, what, where, how old and how long ago", () => {
    expect(v.headline).toBe("An agent calling itself \"orbit-worker\" wants to clean up ORBIT-1042's local leftovers");
    expect(v.sub).toBe("acme/orbit · #322 merged 2 days ago · asked 20 s ago");
    expect(v.size).toBe("5.7 GB");
    expect(v.count).toBe("will be freed, 5 items");
  });

  test("chips: a size where bytes are freed, a count where not; the bar leaves out what frees nothing", () => {
    expect(v.chips.map((c) => `${c.name} ${c.text}`)).toEqual(["Docker 4.1 GB", "Worktree 1.6 GB", "Branch 1", "Stashes 300 KB"]);
    expect(v.bar.map((b) => b.group)).toEqual(["docker", "worktree", "stashes"]);
    expect(v.bar.every((b) => b.flex > 0)).toBe(true);
  });

  test("the patch line shows only when stashes are in the plan; the safety lines always", () => {
    expect(v.notes.map((n) => n.icon)).toEqual(["patch", "shield", "lock"]);
    const noStash = cleanupCardView(req(cleanupCardLines({ ...facts, items: facts.items.slice(0, 3) })), NOW)!;
    expect(noStash.notes.map((n) => n.icon)).toEqual(["shield", "lock"]);
  });

  test("the full list is grouped in plan order", () => {
    expect(v.full.map((g) => [g.name, g.rows.length])).toEqual([["Docker", 2], ["Worktree", 1], ["Branch", 1], ["Stashes", 1]]);
  });

  test("a PR with no slug is named by its number; asked just now under five seconds", () => {
    expect(cleanupCardView(req(cleanupCardLines({ ...facts, slug: "" })), NOW)!.headline).toContain("clean up #322's");
    expect([2_000, 20_000, 120_000].map((ms) => askedWord(NOW - ms, NOW))).toEqual(["just now", "20 s ago", "2 min ago"]);
  });
});

describe("where the card is drawn", () => {
  // Both places an approval shows must draw the one card, or the two would say different things.
  const src = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
  test("the corner request and the Lantern's Waiting section both go through cleanupCardView", async () => {
    for (const p of ["../src/components/SettingsRequests.tsx", "../src/components/agents/AgentsSections.tsx"]) {
      const s = (await src(p)).split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
      expect(s, p).toContain("cleanupCardView(r, ");
      expect(s, p).toContain("<CleanupAskCard");
    }
  });
  test("only the corner draws the card at its own width; the Lantern's fills its column", async () => {
    expect(await src("../src/components/SettingsRequests.tsx")).toContain("<CleanupAskCard corner ");
    expect(await src("../src/components/agents/AgentsSections.tsx")).not.toContain("<CleanupAskCard corner");
    expect(await src("../src/components/cleanupAsk.css")).toContain(".agx-ca[data-corner]");
  });
  test("an agent's card wears the agent glyph the settings nav uses, not the terminal's", async () => {
    const s = await src("../src/components/CleanupAskCard.tsx");
    expect(s).toContain('<GroupIcon name="bot"');
    expect(s).not.toContain("TerminalIcon");
  });
});
