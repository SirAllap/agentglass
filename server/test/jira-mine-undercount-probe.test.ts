import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-mine-undercount-"));
// bun test runs every file in one process (see AGENTS.md "Tests share one process"): a module-level
// override of these that is never put back leaks into whichever test file runs after this one. The
// old probe test did exactly that, which is why round 1's full `server/test/jira*` run came back 17
// red elsewhere (jira-board-sprint, the WIP-limit column test, ...) with none of that file's own
// assertions failing.
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");

const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");
let fake: FakeJira;

beforeAll(async () => {
  fake = startFakeJira({ pageSize: 50 });
  C.__setCredentialsPath(join(dir, "creds.json"));
  J.__setJiraBase(fake.base);
  await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
});
afterAll(async () => {
  await fake.stop();
  C.__clearAll();
  C.__setCredentialsPath(null);
  J.__setJiraBase(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

// Real site shape: 16 open ORBIT cards assigned to me (one an Epic), plus 21 more ORBIT cards
// assigned to me that sit in a Done-CATEGORY status (statusId 5) but are still unresolved (In
// staging / Ready for deployment are like this on the real workspace) — 37 unresolved in ORBIT.
// Jira's own "Assigned to me" is `resolution = Unresolved`, so all 37 belong in it;
// `statusCategory != Done` only sees 16. Plus 3 unresolved ACME cards, to prove the cross-project
// read (no board, no project scope) is not quietly narrowed to one project either.
test("mine() carries unresolved Done-category cards, and is not scoped to one project", async () => {
  const base = fake.state.issues["ORBIT-1000"]!;
  for (let n = 0; n < 16; n++) {
    const key = `ORBIT-${9000 + n}`;
    fake.state.issues[key] = {
      ...structuredClone(base),
      id: String(99000 + n),
      key,
      summary: `Open ${n}`,
      statusId: String(1 + (n % 4)), // categories new/indeterminate only
      assignee: "acc-0001",
      issueType: n === 0 ? "Epic" : "Task",
      parentKey: null,
      resolution: null,
      rank: `0|z${String(n).padStart(5, "0")}:`,
    };
  }
  for (let n = 0; n < 21; n++) {
    const key = `ORBIT-${9100 + n}`;
    fake.state.issues[key] = {
      ...structuredClone(base),
      id: String(99100 + n),
      key,
      summary: `Unresolved but done-category ${n}`,
      statusId: "5", // Done category, but...
      assignee: "acc-0001",
      issueType: "Task",
      parentKey: null,
      resolution: null, // ...never resolved.
      rank: `0|z${String(1000 + n).padStart(5, "0")}:`,
    };
  }
  for (let n = 0; n < 3; n++) {
    const key = `ACME-${9000 + n}`;
    fake.state.issues[key] = {
      ...structuredClone(base),
      id: String(99200 + n),
      key,
      projectKey: "ACME",
      summary: `Acme unresolved ${n}`,
      statusId: String(1 + (n % 4)),
      assignee: "acc-0001",
      issueType: "Task",
      parentKey: null,
      resolution: null,
      rank: `0|z${String(2000 + n).padStart(5, "0")}:`,
    };
  }

  // Cross-project: `mine()` has no project scope, so it is Jira's own "Assigned to me" across the
  // whole site — 37 (ORBIT) + 3 (ACME) = 40, matching the real-site retest in the brief.
  const r = await J.withStored((c) => J.mine(c));
  expect(r.ok).toBe(true);
  expect(r.data!.truncated).toBe(false);
  const got = r.data!.tasks;
  expect(got.filter((t) => t.customId?.startsWith("ORBIT-9")).length).toBe(37);
  expect(got.filter((t) => t.customId?.startsWith("ACME-9")).length).toBe(3);
  expect(got.filter((t) => t.customId?.startsWith("ORBIT-9") && t.statusKind === "done").length).toBe(21);
  expect(got.filter((t) => t.customId?.startsWith("ORBIT-9") && t.statusKind !== "done").length).toBe(16);
  const epic = got.find((t) => t.customId === "ORBIT-9000");
  expect(epic?.statusKind).not.toBe("done");

  // A view scoped to one project (a board's own JQL, or any saved view that ANDs `project = ...` in)
  // counts only that project's cards: "show all" on an ORBIT-scoped view is 37, not 40.
  const scoped = await J.withStored((c) =>
    J.searchJql(c, 'project = "ORBIT" AND assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC'));
  expect(scoped.ok).toBe(true);
  const scopedGot = scoped.data!.tasks.filter((t) => t.customId?.startsWith("ORBIT-9") || t.customId?.startsWith("ACME-9"));
  expect(scopedGot.length).toBe(37);
  expect(scopedGot.some((t) => t.customId?.startsWith("ACME-"))).toBe(false);
});
