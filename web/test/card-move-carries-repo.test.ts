/**
 * A card move from the PR panel asks ClickUp with the PR's repo on every call, so the
 * account that repo chose answers the list read and takes the status write, not the default's.
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
  sent.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}${init?.body ? ` ${init.body}` : ""}`);
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
});
const { api } = await import("../src/lib/api.ts");
beforeEach(() => { sent = []; });

describe("the card move names its repo", () => {
  test("the list read carries ?repo=", async () => {
    await api.clickupList("901", "orbit/web");
    expect(sent).toEqual(["GET /clickup/list?id=901&repo=orbit%2Fweb"]);
  });
  test("the status write carries repo in the body", async () => {
    await api.clickupCard("abc", { status: "qa" }, 5, "orbit/web");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].split(" ").slice(2).join(" "))).toMatchObject({ id: "abc", status: "qa", repo: "orbit/web" });
  });
  test("with no repo the requests are as before", async () => {
    await api.clickupList("901");
    await api.clickupCard("abc", { status: "qa" }, 5);
    expect(sent[0]).toBe("GET /clickup/list?id=901");
    expect(sent[1]).not.toContain("repo");
  });
  test("the panel passes the repo to find, list and write", () => {
    const src = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");
    const from = src.indexOf("const stageCardMove");
    const fn = src.slice(from, src.indexOf("useEffect", from));
    for (const call of ["api.clickupFind(", "api.clickupList(", "api.clickupCard("]) {
      const at = fn.indexOf(call);
      expect(at, call).toBeGreaterThan(0);
      expect(fn.slice(at, fn.indexOf("\n", at)), call).toContain("repo?.nameWithOwner");
    }
  });
});

describe("the Jira pickers name the repo", () => {
  test("people list and assignee write carry it", async () => {
    await api.jiraAssignable("ORBIT-1042", "ann", "", "orbit/web");
    await api.jiraSetAssignee("ORBIT-1042", "u1", 5, "orbit/web");
    expect(sent[0]).toContain("/jira/assignable?");
    expect(sent[0]).toContain("repo=orbit%2Fweb");
    expect(sent[1]).toStartWith("POST /jira/assignee?repo=orbit%2Fweb ");
  });
  test("with no repo the requests are as before", async () => {
    await api.jiraAssignable("ORBIT-1042", "ann");
    await api.jiraSetAssignee("ORBIT-1042", null, 5);
    expect(sent[0]).not.toContain("repo");
    expect(sent[1]).toStartWith("POST /jira/assignee ");
  });
  test("the pickers hand the repo to every tracker call, and the panel gives it to them", () => {
    const read = (f: string) => readFileSync(new URL(`../src/components/${f}`, import.meta.url), "utf8");
    expect(read("TrackerStatusPick.tsx")).toContain("tracker.statusOptions(task, repo)");
    expect(read("TrackerStatusPick.tsx")).toContain("tracker.setStatus(task, opt, undefined, repo)");
    expect(read("TrackerStatusPick.tsx")).toContain("tracker.setStatus(task, opt, values, repo)");
    expect(read("TrackerPeoplePick.tsx")).toContain('ask(task, q, "", repo)');
    expect(read("TrackerPeoplePick.tsx")).toContain("write(task, { set: to }, repo)");
    const panel = read("PrPanel.tsx");
    expect(panel).toContain("<TrackerStatusPick tracker={TRACKERS.jira} task={task} query={query} onSaid={setSaid} chip={CTRL_H.hit} repo={repo} />");
    expect(panel).toContain("<TrackerPeoplePick tracker={TRACKERS.jira} task={task} query={query} onSaid={setSaid} repo={repo} />");
  });
});
