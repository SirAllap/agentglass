/*
 * The space tree against answers that are 2xx but not the JSON it asked for: an empty body is "no data", a body that
 * is not JSON is named (call, status, type, start), and one failed read does not fail the space.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-tree-unreadable-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");

const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");
const S = await import("../src/jiraSpaces.ts");

type Answer = { status?: number; type?: string; body: string };
let components: Answer, search: Answer;
const ok = (o: unknown): Answer => ({ type: "application/json", body: JSON.stringify(o) });
const issues = ok({ issues: [{ key: "ORBIT-1", id: "1", fields: { summary: "Epic", status: { name: "To Do", statusCategory: { key: "new" } } } }], isLast: true });
let server: ReturnType<typeof Bun.serve>;
let calls = 0;
let searchHits = 0;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.includes("/search")) searchHits++;
    const a = u.pathname.includes("/components") ? components : u.pathname.includes("/search") ? search : { type: "application/json", body: JSON.stringify({ accountId: "a1", displayName: "Dev", emailAddress: "dev@acme.example", deploymentType: "Cloud", version: "1001.0.0" }) };
    return new Response(a.body, { status: a.status ?? 200, headers: a.type ? { "content-type": a.type } : {} });
  } });
});
afterAll(() => { server.stop(true); C.__clearAll(); C.__setCredentialsPath(null); J.__setJiraBase(null); for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  C.__setCredentialsPath(join(dir, `creds${calls++}.json`));
  C.__clearAll();
  J.__setJiraGuard(null);
  J.__setJiraBase(`http://127.0.0.1:${server.port}`);
  const r = await J.connectJira({ site: "acme.atlassian.net", email: "dev@acme.example", token: "x".repeat(24) });
  expect(r.ok).toBe(true);
  components = ok([{ id: "10", name: "Core" }]);
  search = issues;
  searchHits = 0;
});

describe("space tree, 2xx that is not the expected JSON", () => {
  test("empty 200 components: no data, the tree still loads", async () => {
    components = { body: "" };
    const r = await S.jiraSpaceTreeStored("ORBIT", true, false);
    expect(r.ok).toBe(true);
  });
  test("empty 202 search body: no epics, no cards, no error", async () => {
    search = { status: 202, body: "" };
    const r = await S.jiraSpaceTreeStored("ORBIT", true, false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.total).toBe(0);
  });
  test("HTML from components: the space loads without them and says so", async () => {
    components = { type: "text/html", body: "<html>Site is waking up</html>" };
    const r = await S.jiraSpaceTreeStored("ORBIT", true, false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.missing).toEqual(["components"]);
  });
  test("a components failure is `missing`, never hidden and never a failed tree", async () => {
    components = { status: 200, type: "text/html", body: "<html>x</html>" };
    const r = await S.jiraSpaceTreeStored("ORBIT", true, false);
    expect(r).toMatchObject({ ok: true, missing: ["components"] });
  });
  test("a partial read is held for a minute: the next request does not re-read the cards", async () => {
    components = { type: "text/html", body: "<html>x</html>" };
    await S.jiraSpaceTreeStored("ORBIT", true, false);
    const after = searchHits;
    const r = await S.jiraSpaceTreeStored("ORBIT", false, false);
    expect(r).toMatchObject({ ok: true, missing: ["components"] });
    expect(searchHits).toBe(after);
  });
  test("an empty 2xx outside the space tree is an error, not data (/project would read as zero spaces)", async () => {
    const r = await J.jiraCall<unknown>({ site: "acme.atlassian.net", email: "dev@acme.example", token: "x".repeat(24) } as never, "/rest/api/2/project");
    expect(r.ok).toBe(true); // body is the myself fixture here: not empty
    components = { body: "" };
    const e = await J.jiraCall<unknown>({ site: "acme.atlassian.net", email: "dev@acme.example", token: "x".repeat(24) } as never, "/rest/api/2/project/ORBIT/components", { fresh: true });
    expect(e.ok).toBe(false);
    expect(e.ok === false && e.error).toBe("Jira answered something that is not JSON (GET /rest/api/2/project/ORBIT/components: 200, no content-type)");
  });
  test("a JSON array where an object is expected is no data, not a crash", async () => {
    search = ok([]);
    const r = await S.jiraSpaceTreeStored("ORBIT", true, false);
    expect(r.ok).toBe(true);
  });
  test("everything unreadable: the error names the call, status, type and start", async () => {
    components = search = { type: "text/plain; charset=utf-8", body: "Please sign in via SSO" };
    const r = await S.jiraSpaceTreeStored("ORBIT", true, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Jira answered something that is not JSON (POST /rest/api/3/search/jql: 200, text/plain)');
  });
});

test("unreadableSentence never quotes the body: no email, id, short token, query or cookie", () => {
  const s = J.unreadableSentence("POST", "/rest/api/3/search/jql?SAMLRequest=abc123", 200, "text/html; x=<b>");
  expect(s).toBe("Jira answered something that is not JSON (POST /rest/api/3/search/jql: 200, text/html)");
  for (const bad of ["abc123", "@", "JSESSIONID", "sid="]) expect(s).not.toContain(bad);
  expect(J.unreadableSentence("GET", "/x", 200, "<img src=x onerror=1>")).not.toContain("<");
});
