/*
 * What the watch and vote controls on a Jira card decide, without a renderer: which of the two are drawn, whether one may be pressed,
 * what it says, and what the counts do after a press. The source tests at the end hold the markup and the hook to the house rules a
 * renderer would otherwise have to see.
 */
import { describe, expect, test } from "bun:test";
import { canPress, followControl, type FollowIn } from "../src/lib/jiraFollow.ts";
import { followAfter, type CardFollow } from "../../shared/jiraFollow.ts";

const f: CardFollow = { watching: false, watchers: 2, voted: false, votes: 1 };
const on: FollowIn = { writes: true, out: null, denied: null, key: "ORBIT-1042" };

describe("which controls are drawn", () => {
  test("nothing before the card is read", () => {
    expect(followControl("watch", undefined, on)).toBeNull();
    expect(followControl("vote", undefined, on)).toBeNull();
  });
  test("a site with voting off draws no vote, and a hidden watcher count draws a watch without one", () => {
    expect(followControl("vote", { ...f, votes: null }, on)).toBeNull();
    expect(followControl("watch", { ...f, watchers: null }, on)).toMatchObject({ label: "Watch", count: "" });
  });
  test("zero and many are counts, said as numbers", () => {
    expect(followControl("watch", { ...f, watchers: 0 }, on)).toMatchObject({ count: "0", title: "Watch ORBIT-1042 · 0 watchers" });
    expect(followControl("vote", { ...f, votes: 128 }, on)).toMatchObject({ count: "128", title: "Vote ORBIT-1042 · 128 votes" });
  });
});

describe("the label never moves with the state", () => {
  test("watching or not, voted or not, the words are the same and the tooltip says what a press does", () => {
    const off = followControl("watch", f, on)!, yes = followControl("watch", { ...f, watching: true }, on)!;
    expect([off.label, yes.label]).toEqual(["Watch", "Watch"]);
    expect([off.on, yes.on]).toEqual([false, true]);
    expect(off.title).toBe("Watch ORBIT-1042 · 2 watchers");
    expect(yes.title).toBe("Stop watching ORBIT-1042 · 2 watchers");
    expect(followControl("vote", { ...f, voted: true }, on)!.title).toBe("Remove vote ORBIT-1042 · 1 vote");
  });
});

describe("when a press may go out", () => {
  test("a toggle may, unless a request is out, and then neither may: only the one asked turns", () => {
    expect(canPress(followControl("watch", f, on)!)).toBe(true);
    const busy = followControl("watch", f, { ...on, out: "watch" })!;
    const other = followControl("vote", f, { ...on, out: "watch" })!;
    expect([busy.busy, other.busy]).toEqual([true, false]);
    expect([canPress(busy), canPress(other)]).toEqual([false, false]);
  });
  test("with writing off there is a count and nothing to press, and the count is still said", () => {
    const c = followControl("watch", { ...f, watching: true }, { ...on, writes: false })!;
    expect(c.mode).toBe("readonly");
    expect(canPress(c)).toBe(false);
    expect(c.count).toBe("2");
    expect(c.title).toBe("2 watchers. You are watching it");
    expect(followControl("vote", f, { ...on, writes: false })!.title).toBe("1 vote");
  });
  test("an account the site refused is not offered it again, and the sentence is the tooltip", () => {
    const c = followControl("watch", f, { ...on, denied: "Your Jira account cannot watch ORBIT-1042" })!;
    expect(c.mode).toBe("denied");
    expect(canPress(c)).toBe(false);
    expect(c.title).toBe("Your Jira account cannot watch ORBIT-1042");
    // Writing off wins: there is nothing to refuse when nothing can be sent.
    expect(followControl("watch", f, { ...on, writes: false, denied: "x" })!.mode).toBe("readonly");
  });
});

describe("the counts after a press are the ones the card had, moved by one", () => {
  test("a watch then a stop returns to where it began, and a press that changed nothing moves nothing", () => {
    const watched = followAfter(f, "watch", true);
    expect(watched.watchers).toBe(3);
    expect(followAfter(watched, "watch", false)).toEqual(f);
    expect(followAfter(watched, "watch", true)).toEqual(watched);
    expect(followControl("watch", watched, on)).toMatchObject({ on: true, count: "3" });
  });
});

const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const hook = await read("../src/components/jira/useJiraFollow.ts");
const view = await read("../src/components/jira/JiraFollow.tsx");
const card = await read("../src/components/jira/JiraCard.tsx");
const facts = await read("../src/components/jira/JiraFacts.tsx");
const chrome = await read("../src/components/CardChrome.tsx");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("the markup keeps the house rules", () => {
  test("the control is the house chip with its own icons and sizes, and no typed glyph or number", () => {
    const c = code(view);
    expect(c).toContain("<Chip");
    expect(c).toContain("ICON.xs");
    expect(c).toContain("EyeIcon");
    expect(c).toContain("ThumbUpIcon");
    expect(c).toContain("pressed={c.on}");
    for (const g of ["✕", "×", "✓", "👁", "👍", "★"]) expect(c, g).not.toContain(g);
    expect(c).not.toMatch(/width=\{?["']?\d/);
  });
  test("the label is the control's own words and never the state's", () => {
    const c = code(view);
    expect(c).toContain("<span>{c.label}</span>");
    expect(c).not.toMatch(/on \? "(Watching|Voted)"/);
  });
  test("pending takes the icon's place in a box of the same size", () => {
    const c = code(view);
    expect(c).toMatch(/width: ICON\.xs, height: ICON\.xs/);
  });
  test("the bar draws them after the copies, in the slot the tracker fills", () => {
    expect(code(chrome)).toMatch(/\{marks\}\s*<span className="flex-1" \/>/);
    expect(code(facts)).toContain("marks={follow ? <JiraFollow");
    expect(code(card)).toContain("follow })}");
  });
});

describe("the hook holds the line", () => {
  test("one press at a time, and an answer for another card is dropped", () => {
    const c = code(hook);
    expect(c).toContain("if (going.current || !was) return;");
    expect(c).toContain("if (forKey !== keyRef.current) return;");
  });
  test("a refusal of the account is remembered only when the site said so, and a press that failed moves no count", () => {
    const c = code(hook);
    expect(c).toContain("if (r.denied) setDenied");
    const failed = /if \(!r\.ok\) \{([^]*?)return;\s*\}/.exec(c);
    expect(failed).not.toBeNull();
    expect(failed![1]).not.toContain("onFollow");
    expect(c).toMatch(/return;\s*\}\s*cb\.current\.onFollow\(/);
  });
  test("what was said and what was refused belong to the card they were about", () => {
    expect(code(hook)).toMatch(/useEffect\(\(\) => \{ setBusy\(null\); setSaid\(""\); setDenied\(\{\}\); going\.current = false; \}, \[o\.cardKey\]\)/);
  });
});
