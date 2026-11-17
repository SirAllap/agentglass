/**
 * Every Jira call that acts on a card or searches for one takes the repo and sends it, so the
 * account that repo chose answers; the ones that are about the site itself (the Jira tab's
 * boards, spaces and settings) stay on the default account and are listed here by name.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { globalStubs } from "./stubGlobal";

const stubGlobal = globalStubs();
let sent: string[] = [];
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000", search: "" });
stubGlobal("fetch", async (input: unknown, init?: { method?: string; body?: string }) => {
  const u = new URL(String(input));
  sent.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
});
const { api } = await import("../src/lib/api.ts");
beforeEach(() => { sent = []; });

const SITE_WIDE = new Set(["jiraConnect", "jiraStatus", "jiraWrites", "jiraWriteKind", "jiraSettings", "jiraSteps", "jiraStatusUnits", "jiraProjectStatuses",
  "jiraSpaces", "jiraSpacePicker", "jiraSpaceTree", "jiraEpicCards", "jiraViews", "jiraView", "jiraBoardContext", "jiraBoardAreas", "jiraViewChoices",
  "jiraProjectChoices", "jiraAddView", "jiraRemoveView", "jiraAddFolder", "jiraRemoveFolder",
  // Jira tab features that came with main: saved queries, filters, board layout and the query box's vocabulary are about the site.
  "jiraJql", "jiraViewCount", "jiraJqlCount", "jiraFilter", "jiraWriteFilter", "jiraPairs", "jiraLearnPairs", "jiraForgetPair", "jiraSetSpaceColumnBoard", "jiraProjectBoards",
  "jiraFavourites", "jiraEditView", "jiraDuplicateView", "jiraSaveJql", "jiraFields", "jiraJqlAutocomplete", "jiraJqlSuggest"]);

describe("Jira calls name the repo", () => {
  test("every card call in api.ts takes a repo", () => {
    const src = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
    const names = [...src.matchAll(/\n  (jira[A-Za-z]+): /g)].map((m) => m[1]).filter((n) => !SITE_WIDE.has(n));
    expect(names.length).toBeGreaterThan(25);
    const bare: string[] = [];
    for (const n of names) {
      const at = src.indexOf(`\n  ${n}: `);
      const end = at + 5 + n.length + src.slice(at + 5 + n.length).search(/\n  [A-Za-z\/]/);
      const head = src.slice(at, src.indexOf("=>", at));
      const body = src.slice(at, end < 0 ? undefined : end);
      if (!head.includes("repo?: string") || !/withRepo|repoQuery|\{ repo \}/.test(body)) bare.push(n);
    }
    expect(bare).toEqual([]);
  });
  test("a GET and a POST send it", async () => {
    await api.jiraDetail("ORBIT-1042", "orbit/web");
    await api.jiraComment("ORBIT-1042", "hi", [], undefined, "orbit/web");
    await api.jiraHandOff("ORBIT-1042", 5, {}, "orbit/web");
    await api.jiraLink("ORBIT-1042", "https://example.com/orbit/web/pull/7", "", "orbit/web");
    expect(sent).toEqual([
      "GET /jira/detail?key=ORBIT-1042&repo=orbit%2Fweb",
      "POST /jira/comment?repo=orbit%2Fweb",
      "POST /jira/handoff?repo=orbit%2Fweb",
      "POST /jira/link?repo=orbit%2Fweb",
    ]);
  });
  test("with no repo nothing changes", async () => {
    await api.jiraDetail("ORBIT-1042");
    await api.jiraWatch("ORBIT-1042", true);
    expect(sent).toEqual(["GET /jira/detail?key=ORBIT-1042", "POST /jira/watch"]);
  });
});
