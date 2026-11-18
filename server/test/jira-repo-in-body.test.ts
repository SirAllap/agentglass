/** A Jira POST names its repo in the body as a ClickUp write does; the query still works and wins. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoOfJiraRequest } from "../src/jiraAccount.ts";

const post = (path: string, body: unknown) => new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const of = (r: Request) => repoOfJiraRequest(r, new URL(r.url));

// The /jira/ edge: the request's repo is read once, then handed to enterJiraForRepo (inline or via a const).
const hasEdgeCall = (src: string) => {
  const at = src.indexOf('pathname.startsWith("/jira/")');
  if (at < 0) return false;
  const block = src.slice(at, at + 1500);
  const inline = /enterJiraForRepo\(\s*await\s+repoOfJiraRequest\(\s*req\s*,\s*url\s*\)\s*\)/;
  const viaConst = /(?:const|let)\s+(\w+)\s*=\s*await\s+repoOfJiraRequest\(\s*req\s*,\s*url\s*\)[\s\S]*?enterJiraForRepo\(\s*\1\s*\)/;
  return inline.test(block) || viaConst.test(block);
};

describe("the repo a Jira request names", () => {
  test("a POST body's repo is read, and the body is still there for the route", async () => {
    const r = post("/jira/transition", { key: "ORBIT-1042", repo: "orbit/web" });
    expect(await of(r)).toBe("orbit/web");
    expect(((await r.json()) as { key: string }).key).toBe("ORBIT-1042");
  });
  test("the query wins over the body", async () => {
    expect(await of(post("/jira/transition?repo=orbit%2Fapi", { repo: "orbit/web" }))).toBe("orbit/api");
  });
  test("no repo anywhere, a GET, or a body that is not JSON is the default account", async () => {
    expect(await of(post("/jira/transition", { key: "ORBIT-1" }))).toBeNull();
    expect(await of(new Request("http://x/jira/task?id=1"))).toBeNull();
    expect(await of(new Request("http://x/jira/attach", { method: "POST", body: "not json" }))).toBeNull();
  });
  test("the edge asks it for every /jira/ route", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    // Whitespace-insensitive: the call may be split across lines.
    expect(hasEdgeCall(src)).toBe(true);
    // Guard the guard: the same check goes red when the call is gone or loses the request's repo.
    expect(hasEdgeCall(src.replace("enterJiraForRepo(", "enterJiraForRepoX("))).toBe(false);
    expect(hasEdgeCall(src.replaceAll("repoOfJiraRequest(req, url)", "null"))).toBe(false);
  });
});
