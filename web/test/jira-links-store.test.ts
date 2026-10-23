/*
 * Opening a Jira card costs one request for its pull requests: not two for two
 * panes, not one per render, and none on a timer.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";

const calls: string[] = [];
let answer: () => Promise<unknown> = async () => ({ ok: true, links: [{ url: "https://github.com/acme/orbit/pull/7", number: 7, title: "acme/orbit#7", resolved: false }] });
const mod = await import("../src/lib/api.ts");
const a = mod.api as unknown as Record<string, unknown>;
const saved = a.jiraLinks;
a.jiraLinks = (k: string) => { calls.push(k); return answer(); };
const { readJiraLinks, addJiraLink, forgetJiraLinks } = await import("../src/lib/jiraLinks.ts");
afterAll(() => { a.jiraLinks = saved; forgetJiraLinks(); });

describe("reading a card's links", () => {
  beforeEach(() => { calls.length = 0; forgetJiraLinks(); });

  it("is one request, however many readers ask while it is in flight", async () => {
    const [x, y] = await Promise.all([readJiraLinks("ORBIT-7"), readJiraLinks("ORBIT-7")]);
    expect(calls).toEqual(["ORBIT-7"]);
    expect(x.links.map((l) => l.number)).toEqual([7]);
    expect(y).toBe(x);
  });

  it("is still one request when the card is shown again, and one more for another card", async () => {
    await readJiraLinks("ORBIT-7");
    await readJiraLinks("ORBIT-7");
    await readJiraLinks("ORBIT-8");
    expect(calls).toEqual(["ORBIT-7", "ORBIT-8"]);
  });

  it("holds a failure too, so a site that does not answer is not asked on every render", async () => {
    answer = async () => ({ ok: false, links: [], error: "Jira did not answer" });
    const r = await readJiraLinks("ORBIT-7");
    await readJiraLinks("ORBIT-7");
    expect(r.error).toBe("Jira did not answer");
    expect(calls.length).toBe(1);
  });

  it("takes a written link into the held list without another read", async () => {
    answer = async () => ({ ok: true, links: [] });
    await readJiraLinks("ORBIT-7");
    const v = addJiraLink("ORBIT-7", { url: "https://github.com/acme/orbit/pull/9", number: 9, title: "acme/orbit#9", resolved: false });
    expect(v.links.map((l) => l.number)).toEqual([9]);
    expect((await readJiraLinks("ORBIT-7")).links.length).toBe(1);
    expect(calls.length).toBe(1);
  });
});

describe("where it is wired", () => {
  const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const store = Bun.file(new URL("../src/lib/jiraLinks.ts", import.meta.url));
  const pane = Bun.file(new URL("../src/components/JiraTasks.tsx", import.meta.url));

  it("the card pane draws the section, once, with the write switch", async () => {
    const src = strip(await pane.text());
    expect(src.match(/<JiraCardPrs /g)?.length).toBe(1);
    expect(src).toContain("<JiraCardPrs query={query} writable={writable}");
  });

  it("nothing in the store polls", async () => {
    expect(strip(await store.text())).not.toMatch(/setInterval|setTimeout/);
  });
});
