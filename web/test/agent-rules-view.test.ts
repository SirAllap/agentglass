/*
 * THE RULES SECTION'S DECISIONS: what a rule is called, where it came from,
 * which ones fold, which suggestion is holding an agent up.
 *
 * Rules are the shape `GET /agent-rules` answers, with invented names
 * (acme/orbit, builder-1). Each guard below was broken on purpose and seen red.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRule } from "../../shared/agentRules.ts";
import {
  LEARNED_SHOWN, agoWords, baseOrder, baseSummary, blockedBy, ruleCode, ruleIcon, ruleTitle, ruleTotals, ruleWhen, rowRequest, sourceChip,
  isUnder, splitLearned, suggestionPhrase, titleOfMatch, WEEK,
} from "../src/lib/agentRulesView.ts";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const DAY = 86_400_000;
const ORBIT = "/home/dev/code/acme/orbit";
let n = 0;
const rule = (o: Partial<AgentRule> & Pick<AgentRule, "match">): AgentRule => ({
  id: `ar_${String(++n).padStart(18, "0")}`, project: ORBIT, action: "bash.thing", setting: "ask", source: "chat", by: "builder-1", at: NOW - 3 * DAY, ...o,
});

describe("what a rule is called", () => {
  test("a shell pattern is the words a person types; a file pattern keeps its tool", () => {
    expect(ruleCode(rule({ match: "Bash(make check:*)" }))).toBe("make check");
    expect(ruleCode(rule({ match: "Bash(git push:*)" }))).toBe("git push");
    expect(ruleCode(rule({ match: "Edit(docs/**)", action: "edit" }))).toBe("Edit docs/**");
    expect(ruleCode(rule({ match: "Bash", action: "bash" }))).toBe("any shell command");
  });
  test("a bare tool reads as its action key when that is a readable one, else its name", () => {
    expect(ruleCode(rule({ match: "mcp__chat__post", action: "chat.post" }))).toBe("chat.post");
    expect(ruleCode(rule({ match: "WebFetch", action: "webfetch" }))).toBe("WebFetch");
  });
  test("the permission mode is not a pattern", () => {
    expect(ruleCode(rule({ match: "", action: "launch.mode", project: "*" }))).toBe("permission mode");
    expect(ruleTitle(rule({ match: "", action: "launch.mode", project: "*" }))).toBe("Run without asking");
  });
  test("the rules people meet first have house names, a longer command of one keeps it", () => {
    expect(ruleTitle(rule({ match: "Bash(git push:*)" }))).toBe("Push code");
    expect(ruleTitle(rule({ match: "Bash(git push --force:*)" }))).toBe("Push code");
    expect(ruleTitle(rule({ match: "Bash(gh pr merge:*)" }))).toBe("Merge pull requests");
    expect(ruleTitle(rule({ match: "Bash(gh release:*)" }))).toBe("Publish a release");
    expect(ruleTitle(rule({ match: "Bash(gh pr create:*)" }))).toBe("Open pull requests");
    expect(ruleTitle(rule({ match: "Bash(npm install:*)" }))).toBe("Install packages");
    expect(ruleTitle(rule({ match: "Bash(sudo:*)" }))).toBe("Run a script as root");
  });
  test("a word that only starts like a house name is not that name", () => {
    expect(ruleTitle(rule({ match: "Bash(git pushover:*)" }))).toBe("Run git pushover");
  });
  test("anything unnamed reads Run <command>, Use <tool>, or the folder a file rule covers", () => {
    expect(ruleTitle(rule({ match: "Bash(make check:*)" }))).toBe("Run make check");
    expect(ruleTitle(rule({ match: "Edit(docs/**)" }))).toBe("Edit files under docs/");
    expect(ruleTitle(rule({ match: "Write(exports/**)" }))).toBe("Write to exports/");
    expect(ruleTitle(rule({ match: "Edit", action: "edit" }))).toBe("Edit files");
    expect(ruleTitle(rule({ match: "mcp__orbit__deploy", action: "mcp__orbit__deploy" }))).toBe("Use mcp__orbit__deploy");
    expect(titleOfMatch("Bash(make deploy-staging:*)")).toBe("Run make deploy-staging");
  });
  test("a suggestion's headline names the thing, in lower case after the project", () => {
    expect(suggestionPhrase(rule({ match: "Bash(make deploy-staging:*)" }))).toBe("deploy to staging");
    expect(suggestionPhrase(rule({ match: "Bash(make lint:*)" }))).toBe("run make lint");
    expect(suggestionPhrase(rule({ match: "mcp__tracker__move_card", action: "tracker.move_card" }))).toBe("move a tracker card");
  });
  test("an icon per kind of rule: a push, a file, a make target, a plain command", () => {
    expect(ruleIcon(rule({ match: "Bash(git push:*)" }))).toBe("arrow-right");
    expect(ruleIcon(rule({ match: "Edit(docs/**)" }))).toBe("pencil-simple");
    expect(ruleIcon(rule({ match: "Bash(make check:*)" }))).toBe("play");
    expect(ruleIcon(rule({ match: "Bash(cargo build:*)" }))).toBe("terminal-window");
    expect(ruleIcon(rule({ match: "", action: "launch.mode", project: "*" }))).toBe("lightning");
  });
});

describe("where a rule came from, and when", () => {
  test("each origin has its own words; a base rule is a base rule whoever touched it last", () => {
    expect(sourceChip({ source: "chat" })).toMatchObject({ kind: "chat", label: "you said it in chat" });
    expect(sourceChip({ source: "first-seen" })).toMatchObject({ kind: "first", label: "seen for the first time" });
    expect(sourceChip({ source: "always-allow" })).toMatchObject({ kind: "always", label: "you pressed Always allow here" });
    expect(sourceChip({ source: "base" })).toMatchObject({ kind: "plain", label: "base rule" });
    expect(sourceChip({ source: "you" }, true).label).toBe("base rule");
    expect(sourceChip({ source: "you" }).label).toBe("you set it");
  });
  test("ages in whole words, the way the design writes them", () => {
    expect(agoWords(NOW - 20_000, NOW)).toBe("just now");
    expect(agoWords(NOW - 60_000, NOW)).toBe("1 minute ago");
    expect(agoWords(NOW - 5 * 3_600_000, NOW)).toBe("5 hours ago");
    expect(agoWords(NOW - DAY, NOW)).toBe("1 day ago");
    expect(agoWords(NOW - 6 * DAY, NOW)).toBe("6 days ago");
    expect(agoWords(NOW - 14 * DAY, NOW)).toBe("2 weeks ago");
    expect(agoWords(NOW - 41 * DAY, NOW)).toBe("5 weeks ago");
    expect(agoWords(NOW - 90 * DAY, NOW)).toBe("3 months ago");
    expect(agoWords(NOW + 5 * DAY, NOW)).toBe("just now");
  });
  test("who it was told to is named for a chat rule, and for a click on Always allow here; never for yourself", () => {
    expect(ruleWhen(rule({ match: "x", source: "chat", by: "builder-1", at: NOW - 3 * DAY }), NOW)).toBe("told to builder-1, 3 days ago");
    expect(ruleWhen(rule({ match: "x", source: "chat", by: "you", at: NOW - 14 * DAY }), NOW)).toBe("2 weeks ago");
    expect(ruleWhen(rule({ match: "x", source: "always-allow", by: "docs-4", at: NOW - 21 * DAY }), NOW)).toBe("docs-4, 3 weeks ago");
    expect(ruleWhen(rule({ match: "x", source: "first-seen", by: "builder-1", at: NOW - 28 * DAY }), NOW)).toBe("4 weeks ago");
    expect(ruleWhen(rule({ match: "x", source: "base" }), NOW, true)).toBe("since install");
  });
});

describe("the lists", () => {
  const learned = (k: number) => Array.from({ length: k }, (_, i) => rule({ match: `Bash(tool${i}:*)`, at: NOW - (i + 1) * 5 * DAY }));
  test("newest first, the last week marked, and past six the rest fold", () => {
    const { shown, older } = splitLearned(learned(12), NOW);
    expect(shown).toHaveLength(LEARNED_SHOWN);
    expect(older).toHaveLength(12 - LEARNED_SHOWN);
    expect(shown.map((r) => r.rule.match)).toEqual(["Bash(tool0:*)", "Bash(tool1:*)", "Bash(tool2:*)", "Bash(tool3:*)", "Bash(tool4:*)", "Bash(tool5:*)"]);
    expect(shown.map((r) => r.fresh)).toEqual([true, false, false, false, false, false]);
  });
  test("a rule exactly a week old is not fresh; five learned rules all show", () => {
    expect(splitLearned([rule({ match: "x", at: NOW - WEEK })], NOW).shown[0]!.fresh).toBe(false);
    expect(splitLearned(learned(5), NOW).older).toHaveLength(0);
  });
  test("input order does not decide the order", () => {
    const rows = learned(3).reverse();
    expect(splitLearned(rows, NOW).shown.map((r) => r.rule.match)[0]).toBe("Bash(tool0:*)");
  });
  test("totals: base plus learned, and what this week added", () => {
    expect(ruleTotals({ base: new Array(4), learned: new Array(12), weekly: [0, 0, 1, 2, 1, 3, 2, 3] })).toEqual({ total: 16, base: 4, learned: 12, week: 3 });
    expect(ruleTotals({ base: [], learned: [], weekly: [] }).week).toBe(0);
    expect(ruleTotals({ base: [], learned: [], weekly: [NaN] }).week).toBe(0);
  });
  test("the base list keeps the permission mode last", () => {
    const mode = rule({ match: "", action: "launch.mode", project: "*" });
    const push = rule({ match: "Bash(git push:*)", project: "*" });
    const merge = rule({ match: "Bash(gh pr merge:*)", project: "*" });
    expect(baseOrder([mode, push, merge]).map((r) => r.match)).toEqual(["Bash(git push:*)", "Bash(gh pr merge:*)", ""]);
  });
});

describe("the base set in one line", () => {
  const base = (push: AgentRule["setting"]) => [
    rule({ match: "", action: "launch.mode", project: "*", setting: "ask" }),
    rule({ match: "Bash(git push:*)", project: "*", setting: push }),
    rule({ match: "Bash(gh pr merge:*)", project: "*", setting: "never" }),
    rule({ match: "Bash(gh release:*)", project: "*", setting: "never" }),
  ];
  test("what is refused, then what the mode does", () => {
    expect(baseSummary(base("never"), "default")).toEqual({ count: 4, lead: "4 base rules are on:", rest: "no push, no merge, no release, ask before risky things." });
  });
  test("an allowed rule is not a refusal", () => {
    expect(baseSummary(base("allow"), "default").rest).toBe("no merge, no release, ask before risky things.");
  });
  test("an ask rule says it asks; a looser mode says so", () => {
    expect(baseSummary(base("ask"), "auto").rest).toBe("ask before git push, no merge, no release, run on its own.");
  });
  test("one rule is singular", () => {
    expect(baseSummary([rule({ match: "Bash(sudo:*)", project: "*", setting: "never" })], "default").lead).toBe("1 base rule is on:");
  });
});

describe("a suggestion that holds an agent up", () => {
  const suggestion = rule({ match: "Bash(make deploy-staging:*)", setting: "ask", source: "first-seen", pending: true });
  const names: Record<string, string> = { "sess-b1": "builder-1" };
  const nameOf = (s: string) => names[s];
  test("the agent whose held call the rule would decide", () => {
    expect(blockedBy(suggestion, ORBIT, [{ session_id: "sess-b1", tool_name: "Bash", summary: "make deploy-staging" }], nameOf)).toBe("builder-1");
  });
  test("a longer command of the same habit, and one inside a chain, still count", () => {
    expect(blockedBy(suggestion, ORBIT, [{ session_id: "sess-b1", tool_name: "Bash", summary: "make deploy-staging --dry" }], nameOf)).toBe("builder-1");
    expect(blockedBy(suggestion, ORBIT, [{ session_id: "sess-b1", tool_name: "Bash", summary: "cd site && make deploy-staging" }], nameOf)).toBe("builder-1");
  });
  test("nobody is waiting when no held call matches, or the call is another tool's", () => {
    expect(blockedBy(suggestion, ORBIT, [], nameOf)).toBeNull();
    expect(blockedBy(suggestion, ORBIT, [{ session_id: "sess-b1", tool_name: "Bash", summary: "make check" }], nameOf)).toBeNull();
    expect(blockedBy(suggestion, ORBIT, [{ session_id: "sess-b1", tool_name: "Edit", summary: "make deploy-staging" }], nameOf)).toBeNull();
  });
  test("a held call from a session the board does not know is still somebody", () => {
    expect(blockedBy(suggestion, ORBIT, [{ session_id: "sess-x", tool_name: "Bash", summary: "make deploy-staging" }], nameOf)).toBe("an agent");
  });
  test("the pending flag does not hide the rule from the check", () => {
    expect(suggestion.pending).toBe(true);
    expect(blockedBy({ ...suggestion, pending: true }, ORBIT, [{ session_id: "sess-b1", tool_name: "Bash", summary: "make deploy-staging" }], nameOf)).not.toBeNull();
  });
});

describe("which project a held call belongs to", () => {
  test("the project's root and anything under it, a worktree included, and nothing that only shares a prefix", () => {
    expect(isUnder(ORBIT, ORBIT)).toBe(true);
    expect(isUnder(`${ORBIT}/.worktrees/fix-retry`, ORBIT)).toBe(true);
    expect(isUnder(`${ORBIT}/`, ORBIT)).toBe(true);
    expect(isUnder(`${ORBIT}-old`, ORBIT)).toBe(false);
    expect(isUnder("/home/dev/code/acme/ledger", ORBIT)).toBe(false);
  });
});

describe("a row's writes", () => {
  test("a click keeps the pattern and its origin when a click may carry that origin", () => {
    const r = rule({ match: "Bash(make check:*)", action: "bash.make.check", source: "always-allow" });
    expect(rowRequest(r, "never")).toEqual({ root: ORBIT, action: "bash.make.check", match: "Bash(make check:*)", setting: "never", source: "always-allow" });
    expect(rowRequest(rule({ match: "Bash(npm install:*)", source: "first-seen" }), "allow")).not.toHaveProperty("source");
  });
  test("a base rule is written to every project", () => {
    expect(rowRequest(rule({ match: "Bash(git push:*)", project: "*" }), "never").root).toBe("*");
  });
});

/*
 * The section is drawn by a component, and there is no renderer in this
 * project: what it promises is asserted against its source. Comment lines are
 * stripped first, so a word in a comment cannot satisfy or break a check.
 */
const SECTION = readFileSync(join(import.meta.dir, "..", "src", "components", "agents", "AgentRulesSection.tsx"), "utf8")
  .split("\n").filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join("\n");

describe("the section's controls", () => {
  test("every button does something: no dead control", () => {
    const buttons = SECTION.split("<button").slice(1).map((b) => b.slice(0, b.indexOf("</button>")));
    expect(buttons.length).toBeGreaterThanOrEqual(6);
    for (const b of buttons) expect(b).toContain("onClick={");
  });
  test("writes go through the two rule routes the agent doors use, and nowhere else", () => {
    expect(SECTION).toContain("api.agentRuleSet(rowRequest(rule, setting))");
    expect(SECTION).toContain("api.agentRuleAnswer(rule.id, a)");
    expect(SECTION).not.toMatch(/\bfetch\(/);
    expect(SECTION).not.toMatch(/api\.(post|put|del)\(/);
  });
  test("the permission mode is written to every project, as the mode rule", () => {
    expect(SECTION).toMatch(/root: "\*", action: MODE_ACTION, match: "", setting: mode === "default" \? "ask" : "allow", mode/);
  });
  test("the rules are read every thirty seconds and not faster", () => {
    expect(SECTION).toContain("const REFRESH_MS = 30_000;");
    expect(SECTION).toContain("setInterval(() => void load(), REFRESH_MS)");
  });
  test("a card's list and the strip come from the pure decisions, not from a second copy", () => {
    expect(SECTION).toContain("growthBars(view.weekly, view.base.length, view.learned.length)");
    expect(SECTION).toContain("splitLearned(view.learned, now)");
    expect(SECTION).toContain("baseOrder(view.base)");
    expect(SECTION).toContain("blockedBy(rule, root, held, nameOf)");
    expect(SECTION).toContain("isUnder(w, root)");
  });
});
