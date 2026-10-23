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
const { readJiraLinks, addJiraLink, forgetJiraLinks, peekJiraLinks, jiraLinksVersion } = await import("../src/lib/jiraLinks.ts");
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
  const pane = Bun.file(new URL("../src/components/jira/JiraCard.tsx", import.meta.url));

  it("the card pane draws the section, once, with the write switch", async () => {
    const src = strip(await pane.text());
    expect(src.match(/<JiraCardPrs /g)?.length).toBe(1);
    expect(src).toContain("<JiraCardPrs query={key} writable={writes} quiet={!writes} mentions={mentions} dev={dev} />");
  });

  it("nothing in the store polls", async () => {
    expect(strip(await store.text())).not.toMatch(/setInterval|setTimeout/);
  });
});

describe("the tab counter reads what is held and asks for nothing", () => {
  beforeEach(() => { calls.length = 0; forgetJiraLinks(); });

  it("peeking is empty before a read, costs no request, and tells listeners when the read lands", async () => {
    answer = async () => ({ ok: true, links: [{ url: "https://github.com/acme/orbit/pull/7", number: 7, title: "acme/orbit#7", resolved: true }] });
    expect(peekJiraLinks("ORBIT-7")).toBeNull();
    expect(calls).toEqual([]);
    const v = jiraLinksVersion();
    await readJiraLinks("ORBIT-7");
    expect(peekJiraLinks("ORBIT-7")?.links.length).toBe(1);
    expect(jiraLinksVersion()).toBeGreaterThan(v);
    expect(calls).toEqual(["ORBIT-7"]);
  });

  it("carries every address the card links to beside the pull requests, from the same single read", async () => {
    answer = async () => ({ ok: true, links: [], web: [{ id: "1", url: "https://docs.acme.example/design/sync", title: "Design note", host: "docs.acme.example" }] });
    const r = await readJiraLinks("ORBIT-7");
    expect(r.web.map((w) => w.title)).toEqual(["Design note"]);
    expect(calls.length).toBe(1);
    // A pull request linked from here joins the web links too, so the two sections agree without another read.
    const v = addJiraLink("ORBIT-7", { url: "https://github.com/acme/orbit/pull/9", number: 9, title: "acme/orbit#9", resolved: false });
    expect(v.web.map((w) => [w.title, !!w.pr])).toEqual([["Design note", false], ["acme/orbit#9", true]]);
  });
});
