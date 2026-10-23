/*
 * A move whose screen asks for fields: the form's values become the request,
 * and a required field left empty never reaches the site. Cloud (ADF) and Data
 * Center (wiki) both, against the stand-in site, plus the pure decisions the
 * form and the server share.
 *
 * What a mistake here costs: a move refused for a field the person could have
 * filled in; a "Done" sent with no resolution that the site answers with a 400
 * and a half-moved card; a choice the site never offered; or a comment written
 * in the wrong format and lost.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira, type FakeScreenField } from "./fixtures/fakeJira.ts";
import { checkMoveFields, effectOf, type JiraMoveField } from "../../shared/jiraMoveFields.ts";
import { moveBody, screenOf } from "../src/jiraMoveFields.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-move-fields-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB", "AGENTGLASS_JIRA_WRITE"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");
delete process.env.AGENTGLASS_JIRA_WRITE;

const C = await import("../src/credentials.ts");
const J = await import("../src/jira.ts");
const credFile = join(dir, "creds.json");
J.__setJiraSettingsPath(join(dir, "jira-settings.json"));

afterAll(() => {
  C.__clearAll();
  C.__setCredentialsPath(null);
  J.__setJiraBase(null);
  J.__setJiraSettingsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

const RESOLUTION: FakeScreenField = {
  key: "resolution", name: "Resolution", required: true, schema: { type: "resolution", system: "resolution" },
  allowedValues: [{ id: "10000", name: "Done" }, { id: "10001", name: "Won't Do" }],
};
const COMMENT: FakeScreenField = { key: "comment", name: "Comment", required: false, schema: { type: "comment", system: "comment" } };
const fieldsOf = (...f: Partial<JiraMoveField>[]): JiraMoveField[] => f.map((x) => ({ key: "k", name: "K", required: false, kind: "text", ...x }));

describe("what a screen asks for, read from the site", () => {
  test("each field gets the kind its schema says, and one it cannot fill is kept and named", () => {
    const screen = screenOf({
      resolution: { required: true, name: "Resolution", schema: { type: "resolution", system: "resolution" }, allowedValues: [{ id: "10000", name: "Done" }] },
      comment: { required: false, name: "Comment", schema: { type: "comment", system: "comment" } },
      customfield_10100: { required: true, name: "Root cause", schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" }, allowedValues: [{ id: "7", value: "Config" }] },
      customfield_10101: { required: false, name: "Notes", schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" } },
      customfield_10102: { required: false, name: "Reviewer", schema: { type: "user", custom: "com.atlassian.jira.plugin.system.customfieldtypes:userpicker" } },
      fixVersions: { required: false, name: "Fix versions", schema: { type: "array", items: "version", system: "fixVersions" }, allowedValues: [{ id: "1", name: "1.0" }] },
    });
    expect(screen.map((f) => [f.key, f.kind, f.required])).toEqual([
      ["resolution", "option", true], ["customfield_10100", "option", true], ["comment", "comment", false],
      ["customfield_10101", "longtext", false], ["customfield_10102", "unsupported", false], ["fixVersions", "options", false],
    ]);
    expect(screen.find((f) => f.key === "customfield_10100")!.choices).toEqual([{ id: "7", name: "Config" }]);
    expect(screen.find((f) => f.key === "customfield_10102")!.type).toBe("userpicker");
  });

  test("a choice field with no choices, or a field with no schema, is unsupported and not guessed", () => {
    const screen = screenOf({
      a: { required: true, name: "A", schema: { type: "option" }, allowedValues: [] },
      b: { required: true, name: "B" },
    });
    expect(screen.map((f) => f.kind)).toEqual(["unsupported", "unsupported"]);
  });
});

describe("the one check the form and the server share", () => {
  const screen = fieldsOf(
    { key: "resolution", name: "Resolution", required: true, kind: "option", choices: [{ id: "1", name: "Done" }] },
    { key: "comment", name: "Comment", kind: "comment" },
    { key: "n", name: "Points", kind: "number" },
    { key: "d", name: "Due", kind: "date" },
    { key: "t", name: "Note", kind: "text" },
  );
  test("a required field left empty, or only spaces, is not enough", () => {
    expect(checkMoveFields(screen, {})).toMatchObject({ ok: false, error: "That move needs Resolution", bad: ["resolution"] });
    expect(checkMoveFields(screen, { resolution: "  " })).toMatchObject({ ok: false, bad: ["resolution"] });
  });
  test("a choice the site never offered, a bad number and a bad date are named", () => {
    expect(checkMoveFields(screen, { resolution: "9" })).toMatchObject({ ok: false, error: "Resolution is not one of the choices" });
    expect(checkMoveFields(screen, { resolution: "1", n: "abc" })).toMatchObject({ ok: false, error: "Points takes a number" });
    expect(checkMoveFields(screen, { resolution: "1", d: "2026-02-31" })).toMatchObject({ ok: false, error: "Due takes a date" });
    expect(checkMoveFields(screen, { resolution: "1", t: "a\nb" })).toMatchObject({ ok: false, error: "Note takes a single line" });
  });
  test("a field the screen does not have is refused, and blanks are left out of what is sent", () => {
    expect(checkMoveFields(screen, { resolution: "1", sneaky: "x" })).toMatchObject({ ok: false, error: "That move does not ask for that field" });
    expect(checkMoveFields(screen, { resolution: "1", comment: " ", t: "" })).toEqual({ ok: true, values: { resolution: "1" } });
  });
  test("a required field of a kind that cannot be filled says so, with the reason", () => {
    const stuck = fieldsOf({ key: "who", name: "Reviewer", required: true, kind: "unsupported", type: "userpicker" });
    expect(checkMoveFields(stuck, {})).toMatchObject({ ok: false, error: "That move needs Reviewer, which cannot be filled in here yet" });
  });
  test("the confirmation says what each filled field does", () => {
    expect(effectOf(screen[0]!, "1")).toBe("Sets Resolution to Done");
    expect(effectOf(screen[1]!, "words")).toBe("Adds your comment");
    expect(effectOf(screen[0]!, "1", true)).toBe("Set Resolution to Done");
    expect(effectOf(screen[1]!, "words", true)).toBe("Added your comment");
    expect(effectOf(screen[0]!, "")).toBeNull();
  });
});

describe("the request a filled form becomes", () => {
  const screen = screenOf({
    resolution: { required: true, name: "Resolution", schema: { type: "resolution", system: "resolution" }, allowedValues: [{ id: "10000", name: "Done" }] },
    comment: { required: false, name: "Comment", schema: { type: "comment", system: "comment" } },
  });
  test("Cloud writes the comment as ADF and the choice by id", () => {
    const r = moveBody("51", screen, { resolution: "10000", comment: "Shipped **today**" }, 3);
    expect(r.ok && r.body.transition).toEqual({ id: "51" });
    expect(r.ok && r.body.fields).toEqual({ resolution: { id: "10000" } });
    const add = r.ok ? (r.body.update!.comment as { add: { body: { type: string; version: number } } }[])[0]!.add.body : null;
    expect(add).toMatchObject({ type: "doc", version: 1 });
  });
  test("Data Center writes the comment as wiki markup", () => {
    const r = moveBody("51", screen, { resolution: "10000", comment: "Shipped **today**" }, 2);
    const add = r.ok ? (r.body.update!.comment as { add: { body: unknown } }[])[0]!.add.body : null;
    expect(add).toBe("Shipped *today*");
  });
  test("nothing is built for an empty required field, or for something that is not a table of values", () => {
    expect(moveBody("51", screen, {}, 3)).toEqual({ ok: false, error: "That move needs Resolution" });
    expect(moveBody("51", screen, "10000", 3)).toEqual({ ok: false, error: "fields must be an object of values by field key" });
    expect(moveBody("51", screen, ["10000"], 3).ok).toBe(false);
  });
  test("a move with no screen is the bare body it always was", () => {
    expect(moveBody("11", undefined, undefined, 3)).toEqual({ ok: true, body: { transition: { id: "11" } } });
  });
});

function suite(flavor: FakeFlavor) {
  const dc = flavor === "datacenter";
  describe(`moving a card through a form, ${dc ? "Data Center (v2)" : "Cloud (v3)"}`, () => {
    let fake: FakeJira;
    beforeAll(() => { fake = startFakeJira({ flavor }); });
    afterAll(async () => { await fake.stop(); });
    const added: { from: string; id: string }[] = [];
    const addMove = (from: string, id: string, screen: FakeScreenField[]) => {
      fake.state.workflow.transitions[from]!.push({ id, name: `Finish ${id}`, toStatusId: "5", requiredFields: [], acceptsAssignee: false, screen });
      added.push({ from, id });
    };
    beforeEach(async () => {
      fake.reset();
      C.__setCredentialsPath(credFile);
      C.__clearAll();
      J.__setJiraBase(fake.base);
      J.__setJiraGuard(null);
      process.env.AGENTGLASS_JIRA_WRITE = "1";
      const r = dc
        ? await J.connectJira({ site: "jira.acme.example", token: FAKE_PAT })
        : await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
      addMove("2", "51", [RESOLUTION, COMMENT]);
      addMove("2", "52", [{ key: "reviewer", name: "Reviewer", required: true, schema: { type: "user" } }]);
      fake.requests.length = 0;
    });
    afterEach(() => {
      for (const a of added.splice(0)) {
        const list = fake.state.workflow.transitions[a.from]!;
        list.splice(list.findIndex((t) => t.id === a.id), 1);
      }
      delete process.env.AGENTGLASS_JIRA_WRITE;
      J.__setJiraBase(null);
    });
    const upd = () => Date.parse(fake.state.issues["ORBIT-1042"]!.updated);
    const posts = () => fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/transitions"));

    test("the list carries the screen for a move that has to ask, and nothing for one that does not", async () => {
      const r = await J.movesStored("ORBIT-1042");
      const mv = (id: string) => r.data!.options.find((o) => o.id === id)!;
      expect(mv("51").needs).toEqual(["resolution"]);
      expect(mv("51").fields!.map((f) => [f.key, f.kind])).toEqual([["resolution", "option"], ["comment", "comment"]]);
      expect(mv("51").fields![0]!.choices).toEqual([{ id: "10000", name: "Done" }, { id: "10001", name: "Won't Do" }]);
      expect(mv("21").fields).toBeUndefined();
    });

    test("filled in: one POST with the choice and the comment in the site's format, and the card is done", async () => {
      const before = fake.state.issues["ORBIT-1042"]!.comments.length;
      const r = await J.moveStored("ORBIT-1042", "51", upd(), { resolution: "10001", comment: "Not needed any more" });
      expect(r.ok).toBe(true);
      const sent = posts()[0]!.body as { transition: { id: string }; fields: unknown; update: { comment: { add: { body: unknown } }[] } };
      expect(sent.transition).toEqual({ id: "51" });
      expect(sent.fields).toEqual({ resolution: { id: "10001" } });
      expect(typeof sent.update.comment[0]!.add.body).toBe(dc ? "string" : "object");
      const issue = fake.state.issues["ORBIT-1042"]!;
      expect(issue.statusId).toBe("5");
      expect(issue.resolution).toBe("Won't Do");
      expect(issue.comments.length).toBe(before + 1);
    });

    test("only the required field: no comment is written", async () => {
      const before = fake.state.issues["ORBIT-1042"]!.comments.length;
      expect((await J.moveStored("ORBIT-1042", "51", upd(), { resolution: "10000" })).ok).toBe(true);
      expect(fake.state.issues["ORBIT-1042"]!.comments.length).toBe(before);
    });

    test("a required field left empty: a sentence, and no POST", async () => {
      for (const given of [undefined, {}, { resolution: "" }, { comment: "words only" }]) {
        const r = await J.moveStored("ORBIT-1042", "51", upd(), given);
        expect(r).toEqual({ ok: false, error: "That move needs Resolution" });
      }
      expect(posts().length).toBe(0);
      expect(fake.state.issues["ORBIT-1042"]!.statusId).toBe("2");
    });

    test("a choice the site did not offer, and a field the screen lacks: refused with no POST", async () => {
      expect((await J.moveStored("ORBIT-1042", "51", upd(), { resolution: "99999" })).error).toBe("Resolution is not one of the choices");
      expect((await J.moveStored("ORBIT-1042", "51", upd(), { resolution: "10000", assignee: "x" })).error).toBe("That move does not ask for that field");
      expect(posts().length).toBe(0);
    });

    test("a required field of a kind this cannot fill: said, and no POST", async () => {
      expect(await J.moveStored("ORBIT-1042", "52", upd(), {})).toEqual({ ok: false, error: "That move needs Reviewer, which cannot be filled in here yet" });
      expect(await J.moveStored("ORBIT-1042", "52", upd(), { reviewer: "acc-0001" })).toEqual({ ok: false, error: "Reviewer cannot be filled in here yet" });
      expect(posts().length).toBe(0);
    });

    test("writes off, or a stale stamp: the form's values change nothing", async () => {
      expect((await J.moveStored("ORBIT-1042", "51", upd() - 5000, { resolution: "10000" })).conflict).toBe(true);
      delete process.env.AGENTGLASS_JIRA_WRITE;
      expect(await J.moveStored("ORBIT-1042", "51", upd(), { resolution: "10000" })).toEqual({ ok: false, error: "Writing to Jira is switched off" });
      expect(posts().length).toBe(0);
    });
  });
}

suite("cloud");
suite("datacenter");
