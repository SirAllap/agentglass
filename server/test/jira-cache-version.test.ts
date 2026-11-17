/* A cached view written before the status rules changed is never served: its statuses must not paint first. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __clear, __setJiraViewsPath, cachedFor, putCache } from "../src/jiraviews.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-cachev-"));
beforeAll(() => { __setJiraViewsPath(join(dir, "views.json")); __clear(); });
afterAll(() => { __setJiraViewsPath(null); rmSync(dir, { recursive: true, force: true }); });

const view = { id: "board:1", name: "ORBIT board", url: "https://acme.example/b", addedAt: 0 };
const entry = { view, tasks: [], columns: [], statuses: [{ status: "BACKLOG", type: "custom", orderindex: 0 }], at: 1 };

test("an entry written by this code is served", () => {
  putCache("acme.example", "board:1", entry);
  expect(cachedFor("acme.example", "board:1")?.statuses?.length).toBe(1);
});
test("an entry without the current version is not served", () => {
  __clear();
  const old = { ...entry };
  // Older code wrote no version: put it on disk as that code did.
  putCache("acme.example", "board:1", old);
  const raw = JSON.parse(require("node:fs").readFileSync(join(dir, "views.json"), "utf8"));
  delete raw.sites["acme.example"].cache["board:1"].sv;
  require("node:fs").writeFileSync(join(dir, "views.json"), JSON.stringify(raw));
  __setJiraViewsPath(join(dir, "views.json"));
  expect(cachedFor("acme.example", "board:1")).toBeUndefined();
});
