/*
 * The JQL box's help: the site's vocabulary (fields, their operators and types, functions), kept ten minutes, and
 * one field's values or people as they are typed, kept a short while and the misses too — against the Cloud fake.
 * Data Center answers no vocabulary rather than guessing a shape it does not have.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-jql-ac-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");

const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");
const A = await import("../src/jiraJqlAutocomplete.ts");

afterAll(() => {
  C.__clearAll();
  C.__setCredentialsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

function suite(flavor: FakeFlavor) {
  const dc = flavor === "datacenter";
  describe(`JQL autocomplete, ${dc ? "Data Center (v2)" : "Cloud (v3)"}`, () => {
    let fake: FakeJira;
    beforeAll(() => { fake = startFakeJira({ flavor }); });
    afterAll(async () => { await fake.stop(); });
    beforeEach(async () => {
      fake.reset();
      C.__setCredentialsPath(join(dir, "creds.json"));
      C.__clearAll();
      J.__setJiraBase(fake.base);
      J.__setJiraGuard(null);
      const r = dc
        ? await J.connectJira({ site: "jira.acme.example", token: FAKE_PAT })
        : await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
      fake.requests.length = 0;
    });
    afterEach(() => { J.__setJiraBase(null); });

    const ac = () => fake.requests.filter((r) => r.path === "/jql/autocompletedata").length;

    if (!dc) {
      test("the vocabulary: fields keep their own operators and types, functions too, and it is kept ten minutes", async () => {
        const r = await A.jqlAutocompleteDataStored();
        expect(r.ok).toBe(true);
        const assignee = r.data!.fields.find((f) => f.value === "assignee");
        expect(assignee).toMatchObject({ displayName: "Assignee", types: ["user"] });
        expect(assignee!.operators).toEqual(expect.arrayContaining(["=", "in"]));
        const summary = r.data!.fields.find((f) => f.value === "summary");
        expect(summary!.operators).toContain("~");
        expect(r.data!.functions.map((f) => f.value)).toEqual(expect.arrayContaining(["currentUser()"]));
        await A.jqlAutocompleteDataStored();
        expect(ac()).toBe(1);
      });

      test("a field's values, one read per typed query, and the bold markers stripped for the row's label", async () => {
        fake.state.issues["ORBIT-1042"]!.labels = ["backend", "billing"];
        const r = await A.jqlFieldSuggestionsStored("labels", "b");
        expect(r.ok).toBe(true);
        expect(r.data!.map((s) => s.value)).toEqual(expect.arrayContaining(["backend", "billing"]));
        expect(r.data!.every((s) => !s.display.includes("<b>"))).toBe(true);
        const before = fake.requests.filter((x) => x.path === "/jql/autocompletedata/suggestions").length;
        await A.jqlFieldSuggestionsStored("labels", "b");
        expect(fake.requests.filter((x) => x.path === "/jql/autocompletedata/suggestions").length).toBe(before);
      });

      test("a field name that is not a word is refused before it reaches the site", async () => {
        const r = await A.jqlFieldSuggestionsStored("labels); DROP", "x");
        expect(r).toEqual({ ok: true, data: [] });
        expect(fake.requests.filter((x) => x.path === "/jql/autocompletedata/suggestions").length).toBe(0);
      });
    } else {
      test("no vocabulary and no values: the box falls back to typing with no help, and asks the site nothing", async () => {
        expect(await A.jqlAutocompleteDataStored()).toEqual({ ok: true, data: { fields: [], functions: [] } });
        expect(ac()).toBe(0);
        expect(await A.jqlFieldSuggestionsStored("labels", "b")).toEqual({ ok: true, data: [] });
        expect(fake.requests.length).toBe(0);
      });
    }
  });
}

suite("cloud");
suite("datacenter");
