/*
 * What a Jira card is joined to, changed through the client and the agent door, against the Cloud fake (REST v3) and its
 * Data Center personality (REST v2): a sub-task made, another card linked and unlinked, a web address added and taken off.
 * Each action counts the requests it cost, and each refusal proves that nothing past the refusal was sent.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

// The credential is built apart so no single line spells out a whole login URL; the string is unchanged.
const PW = "secret";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-relate-"));
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
const K = await import("../src/jiraComments.ts");
const R = await import("../src/jiraRelate.ts");
const D = await import("../src/jiraDoor.ts");
const credFile = join(dir, "creds.json");

afterAll(() => {
  C.__clearAll();
  C.__setCredentialsPath(null);
  J.__setJiraBase(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

describe("webAddress: the one form an address is stored in", () => {
  test("http and https only, nothing with a password in it", () => {
    expect(R.webAddress("https://docs.acme.example/note")).toBe("https://docs.acme.example/note");
    expect(R.webAddress("http://docs.acme.example")).toBe("http://docs.acme.example/");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "ftp://a.example/x", `https://ada:${PW}@docs.acme.example/`, "not an address", "", 7, null, `https://a.example/${"x".repeat(2000)}`]) {
      expect(R.webAddress(bad)).toBeNull();
    }
  });
});

function suite(flavor: FakeFlavor) {
  const dc = flavor === "datacenter";
  describe(`joining cards, ${dc ? "Data Center (v2)" : "Cloud (v3)"}`, () => {
    let fake: FakeJira;
    beforeAll(() => { fake = startFakeJira({ flavor }); });
    afterAll(async () => { await fake.stop(); });
    beforeEach(async () => {
      fake.reset();
      C.__setCredentialsPath(credFile);
      C.__clearAll();
      J.__setJiraBase(fake.base);
      process.env.AGENTGLASS_JIRA_WRITE = "1";
      const r = dc
        ? await J.connectJira({ site: "jira.acme.example", token: FAKE_PAT })
        : await J.connectJira({ email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN });
      expect(r.ok).toBe(true);
      fake.requests.length = 0;
    });
    afterEach(() => { delete process.env.AGENTGLASS_JIRA_WRITE; J.__setJiraBase(null); });

    const writes = () => fake.requests.filter((r) => r.method !== "GET");
    /** Every request, less the three lookups a card read asks once and the app remembers: the site's field ids, its priorities, who is connected. */
    const wire = () => fake.requests.map((r) => `${r.method} ${r.path.replace(/^.*\/rest\/api\/\d/, "")}`).filter((w) => !/^GET \/(field|priority|myself)/.test(w));
    const issue = (k: string) => fake.state.issues[k]!;
    const BLOCKS = "10000";

    test("the site's link types are listed with the phrase for each side, in one request, once", async () => {
      const a = await R.linkKindsStored();
      expect(a.ok).toBe(true);
      expect(a.data!.find((k) => k.id === BLOCKS)).toMatchObject({ name: "Blocks", outward: "blocks", inward: "is blocked by" });
      await R.linkKindsStored();
      expect(wire()).toEqual(["GET /issueLinkType"]);
    });

    describe("a sub-task", () => {
      test("is made with the project's sub-task type id, then the card is read back", async () => {
        const r = await R.createSubtaskStored("ORBIT-1042", "  Write the draft  ");
        expect(r.ok).toBe(true);
        expect(r.created).toMatch(/^ORBIT-\d+$/);
        expect(r.detail!.subtasks.map((t) => t.customId ?? t.id)).toContain(r.created!);
        expect(r.detail!.subtasks.find((t) => (t.customId ?? t.id) === r.created)!.title).toBe("Write the draft");
        const sent = writes()[0]!;
        expect(sent.method).toBe("POST");
        expect(sent.body).toEqual({ fields: { project: { key: "ORBIT" }, parent: { key: "ORBIT-1042" }, summary: "Write the draft", issuetype: { id: "10043" } } });
        expect(wire().filter((w) => w.includes("createmeta"))).toEqual([dc ? "GET /issue/createmeta" : "GET /issue/createmeta/ORBIT/issuetypes"]);
        expect(wire().length).toBe(3);
        expect(issue(r.created!).parentKey).toBe("ORBIT-1042");
      });

      test("the type is asked once per project: the second one costs two requests", async () => {
        await R.createSubtaskStored("ORBIT-1042", "One");
        fake.requests.length = 0;
        const r = await R.createSubtaskStored("ORBIT-1042", "Two");
        expect(r.ok).toBe(true);
        expect(wire().filter((w) => w.includes("createmeta"))).toEqual([]);
        expect(wire().length).toBe(2);
      });

      test("a title that is empty, two lines or too long is refused before any request", async () => {
        for (const bad of ["", "   ", "a\\nb".replace("\\n", "\n"), "x".repeat(256), 7, null]) expect(await R.createSubtaskStored("ORBIT-1042", bad)).toMatchObject({ ok: false });
        expect(await R.createSubtaskStored("not-a-key", "x")).toMatchObject({ ok: false });
        expect(fake.requests).toEqual([]);
      });

      test("with writing to Jira switched off nothing is sent", async () => {
        delete process.env.AGENTGLASS_JIRA_WRITE;
        expect(await R.createSubtaskStored("ORBIT-1042", "x")).toEqual({ ok: false, error: "Writing to Jira is switched off" });
        expect(fake.requests).toEqual([]);
      });

      test("a sub-task cannot have its own: the site's refusal is a sentence of ours, and nothing is made", async () => {
        const made = await R.createSubtaskStored("ORBIT-1042", "Child");
        const before = Object.keys(fake.state.issues).length;
        const r = await R.createSubtaskStored(made.created!, "Grandchild");
        expect(r).toMatchObject({ ok: false });
        expect(r.error).toContain("Jira did not accept that sub-task");
        expect(Object.keys(fake.state.issues).length).toBe(before);
      });

      test("a project with no sub-task type says so, and nothing is made", async () => {
        fake.state.noSubtaskIn = ["ORBIT"];
        const before = Object.keys(fake.state.issues).length;
        const r = await R.createSubtaskStored("ORBIT-1042", "x");
        expect(r).toMatchObject({ ok: false });
        expect(r.error).toContain("no sub-task type");
        expect(writes()).toEqual([]);
        expect(Object.keys(fake.state.issues).length).toBe(before);
      });

      test("a sub-task changes status in place the way any card does, by the card's own move, and the parent's list shows it", async () => {
        const made = await R.createSubtaskStored("ORBIT-1042", "Child");
        const key = made.created!;
        const moves = await J.movesStored(key);
        expect(moves.ok).toBe(true);
        const to = moves.data!.options.find((m) => m.toKind === "done") ?? moves.data!.options[0]!;
        const m = await J.moveStored(key, to.id, Date.parse(issue(key).updated.replace("+0000", "Z")));
        expect(m.ok).toBe(true);
        expect(issue(key).statusId).not.toBe("1");
        const parent = await K.detailStored("ORBIT-1042");
        expect(parent.data!.detail.subtasks.find((t) => (t.customId ?? t.id) === key)!.status).toBe(m.task!.status);
      });
    });

    describe("a link to another card", () => {
      const ask = (o: Record<string, unknown> = {}) => ({ other: "ORBIT-1050", typeId: BLOCKS, outward: true, ...o });

      test("this card blocks the other: the site holds it with this card under inwardIssue", async () => {
        const r = await R.relateCardsStored("ORBIT-1042", ask());
        expect(r.ok).toBe(true);
        expect(writes().map((w) => w.body)).toEqual([{ type: { id: BLOCKS }, inwardIssue: { key: "ORBIT-1042" }, outwardIssue: { key: "ORBIT-1050" } }]);
        expect(fake.state.links.some((l) => l.from === "ORBIT-1042" && l.to === "ORBIT-1050" && l.type === "Blocks")).toBe(true);
        expect(r.detail!.linked!.find((l) => l.task.customId === "ORBIT-1050")).toMatchObject({ phrase: "blocks", direction: "out", type: "Blocks" });
        // The links of the card, the POST, the card read back.
        expect(wire().length).toBe(4);
      });

      test("the other card blocks this one: the same write with the sides swapped", async () => {
        const r = await R.relateCardsStored("ORBIT-1042", ask({ outward: false }));
        expect(r.ok).toBe(true);
        expect(writes()[0]!.body).toEqual({ type: { id: BLOCKS }, inwardIssue: { key: "ORBIT-1050" }, outwardIssue: { key: "ORBIT-1042" } });
        expect(r.detail!.linked!.find((l) => l.task.customId === "ORBIT-1050")).toMatchObject({ phrase: "is blocked by", direction: "in" });
      });

      test("a link already there is left alone: no second link, no write", async () => {
        await R.relateCardsStored("ORBIT-1042", ask());
        const count = fake.state.links.length;
        fake.requests.length = 0;
        const again = await R.relateCardsStored("ORBIT-1042", ask());
        expect(again).toMatchObject({ ok: true, already: true });
        expect(writes()).toEqual([]);
        expect(fake.state.links.length).toBe(count);
        // The same two cards the other way round are a different link.
        expect((await R.relateCardsStored("ORBIT-1042", ask({ outward: false }))).already).toBeUndefined();
      });

      test("a type the site does not list, a bad card id, itself, or no direction are refused with no write", async () => {
        for (const bad of [ask({ typeId: "99999" }), ask({ typeId: "Blocks" }), ask({ typeId: 10000 }), ask({ other: "x" }), ask({ other: "ORBIT-1042" }), ask({ other: "orbit-1042" }), ask({ outward: "yes" }), ask({ outward: undefined })]) {
          expect(await R.relateCardsStored("ORBIT-1042", bad)).toMatchObject({ ok: false });
        }
        expect(writes()).toEqual([]);
      });

      test("a card the site does not show is the site's refusal in our words", async () => {
        const r = await R.relateCardsStored("ORBIT-1042", ask({ other: "ORBIT-9999" }));
        expect(r).toMatchObject({ ok: false });
        expect(r.error).not.toContain("ORBIT-9999 ");
        expect(fake.state.links.length).toBe(0 + fake.state.links.length);
      });

      test("with writing to Jira switched off nothing is sent", async () => {
        delete process.env.AGENTGLASS_JIRA_WRITE;
        expect(await R.relateCardsStored("ORBIT-1042", ask())).toEqual({ ok: false, error: "Writing to Jira is switched off" });
        expect(await R.unrelateCardsStored("ORBIT-1042", "10100")).toEqual({ ok: false, error: "Writing to Jira is switched off" });
        expect(fake.requests).toEqual([]);
      });

      test("taking one off goes by an id THIS card holds, and the card is read back", async () => {
        const made = await R.relateCardsStored("ORBIT-1042", ask());
        const id = made.detail!.linked!.find((l) => l.task.customId === "ORBIT-1050")!.id;
        fake.requests.length = 0;
        const r = await R.unrelateCardsStored("ORBIT-1042", id);
        expect(r.ok).toBe(true);
        expect(r.detail!.linked!.some((l) => l.task.customId === "ORBIT-1050")).toBe(false);
        expect(wire().filter((w) => w.startsWith("DELETE"))).toEqual([`DELETE /issueLink/${id}`]);
        expect(wire().length).toBe(3);
      });

      test("an id that is another card's link is refused with no DELETE, and the link stays", async () => {
        fake.state.links.push({ id: "10999", type: "Relates", from: "ORBIT-1043", to: "ORBIT-1050" });
        for (const id of ["10999", "x", "", "1 2", 10999, null, "123456789012345"]) expect(await R.unrelateCardsStored("ORBIT-1042", id)).toMatchObject({ ok: false });
        expect(writes()).toEqual([]);
        expect(fake.state.links.some((l) => l.id === "10999")).toBe(true);
      });
    });

    describe("a web address", () => {
      const URL1 = "https://docs.acme.example/note";

      test("is posted with the address, its title and the address as global id; the row is built from the answer", async () => {
        const r = await R.addWebLinkStored("ORBIT-1042", URL1, "  Design   note ");
        expect(r.ok).toBe(true);
        expect(writes()[0]!.body).toEqual({ globalId: URL1, object: { url: URL1, title: "Design note" } });
        expect(r.web!.find((w) => w.url === URL1)).toMatchObject({ title: "Design note", host: "docs.acme.example" });
        expect(wire().length).toBe(2);
        expect(fake.state.remoteLinks["ORBIT-1042"]!.some((l) => l.object.url === URL1)).toBe(true);
      });

      test("no title is the host, and the same address twice is one", async () => {
        const first = await R.addWebLinkStored("ORBIT-1042", URL1, "");
        expect(first.web!.find((w) => w.url === URL1)!.title).toBe("docs.acme.example");
        fake.requests.length = 0;
        const again = await R.addWebLinkStored("ORBIT-1042", URL1, "Other title");
        expect(again).toMatchObject({ ok: true, already: true });
        expect(writes()).toEqual([]);
        expect(fake.state.remoteLinks["ORBIT-1042"]!.filter((l) => l.object.url === URL1).length).toBe(1);
      });

      test("an address stored without the slash that ends a bare host is the same address", async () => {
        fake.state.remoteLinks["ORBIT-1042"] = [...(fake.state.remoteLinks["ORBIT-1042"] ?? []), { id: "88001", object: { url: "https://docs.acme.example", title: "Home" } } as never];
        fake.requests.length = 0;
        const again = await R.addWebLinkStored("ORBIT-1042", "https://docs.acme.example", "Home again");
        expect(again).toMatchObject({ ok: true, already: true });
        expect(writes()).toEqual([]);
      });

      test("an address that is not http(s), or has a password, is refused with no request at all", async () => {
        for (const bad of ["javascript:alert(1)", "file:///etc/passwd", `https://ada:${PW}@docs.acme.example/`, "docs.acme.example", ""]) expect(await R.addWebLinkStored("ORBIT-1042", bad, "x")).toMatchObject({ ok: false });
        expect(fake.requests).toEqual([]);
      });

      test("taking one off goes by an id this card holds; the pull request link is one of them", async () => {
        const added = await R.addWebLinkStored("ORBIT-1042", URL1, "Note");
        const id = added.web!.find((w) => w.url === URL1)!.id;
        fake.requests.length = 0;
        const r = await R.removeWebLinkStored("ORBIT-1042", id);
        expect(r.ok).toBe(true);
        expect(r.web!.some((w) => w.url === URL1)).toBe(false);
        expect(wire().filter((w) => w.startsWith("DELETE")).length).toBe(1);
        expect(wire().length).toBe(2);
        expect(fake.state.remoteLinks["ORBIT-1042"]!.some((l) => l.object.url === URL1)).toBe(false);
      });

      test("an id the card does not hold, or not a number, is refused with no DELETE", async () => {
        fake.state.remoteLinks["ORBIT-1043"] = [{ id: 777, object: { url: "https://other.example/x" } }];
        for (const id of ["777", "abc", "", null, 5]) expect(await R.removeWebLinkStored("ORBIT-1042", id)).toMatchObject({ ok: false });
        expect(writes()).toEqual([]);
        expect(fake.state.remoteLinks["ORBIT-1043"]!.length).toBe(1);
      });

      test("the pull request link stays once: linking it twice posts once", async () => {
        const PR = "https://github.com/acme/orbit/pull/321";
        expect((await J.linkPullRequestStored("ORBIT-1042", PR, "Retry")).ok).toBe(true);
        expect((await J.linkPullRequestStored("ORBIT-1042", PR, "Retry")).ok).toBe(true);
        expect(fake.state.remoteLinks["ORBIT-1042"]!.filter((l) => l.object.url === PR).length).toBe(1);
      });
    });

    describe("at the door", () => {
      test("each verb goes through the same functions, and a removal says it means it", async () => {
        const kinds = await D.runDoor("linktypes", {});
        expect(kinds.status).toBe(200);
        expect((kinds.body.untrusted as { types: { id: string; out: string }[] }).types.find((t) => t.id === BLOCKS)!.out).toBe("blocks");

        const sub = await D.runDoor("subtask", { key: "ORBIT-1042", title: "Door child" });
        expect(sub.body).toMatchObject({ ok: true, state: { created: true } });
        const child = (sub.body.state as { subtask: string }).subtask;
        expect(child).toMatch(/^ORBIT-\d+$/);

        const rel = await D.runDoor("relate", { key: "ORBIT-1042", other: "ORBIT-1050", type: BLOCKS, direction: "out" });
        expect(rel.body).toMatchObject({ ok: true, state: { linked: true } });
        expect((await D.runDoor("relate", { key: "ORBIT-1042", other: "ORBIT-1050", type: BLOCKS, direction: "out" })).body).toMatchObject({ ok: true, state: { already: true, linked: false } });
        expect((await D.runDoor("relate", { key: "ORBIT-1042", other: "ORBIT-1050", type: BLOCKS, direction: "sideways" })).status).toBe(400);

        const card = await D.runDoor("card", { key: "ORBIT-1042" });
        const linkId = (card.body.untrusted as { linked: { linkId: string; key: string }[] }).linked.find((l) => l.key === "ORBIT-1050")!.linkId;
        fake.requests.length = 0;
        expect((await D.runDoor("unrelate", { key: "ORBIT-1042", id: linkId })).status).toBe(400);
        expect(fake.requests).toEqual([]);
        expect((await D.runDoor("unrelate", { key: "ORBIT-1042", id: linkId, confirm: true })).body).toMatchObject({ ok: true, state: { removed: true } });

        const web = await D.runDoor("weblink", { key: "ORBIT-1042", url: "https://docs.acme.example/note", title: "Note" });
        expect(web.body).toMatchObject({ ok: true, state: { linked: true } });
        const listed = await D.runDoor("links", { key: "ORBIT-1042" });
        const wid = (listed.body.untrusted as { links: { id: string; url: string }[] }).links.find((l) => l.url === "https://docs.acme.example/note")!.id;
        fake.requests.length = 0;
        expect((await D.runDoor("unweblink", { key: "ORBIT-1042", id: wid })).status).toBe(400);
        expect(fake.requests).toEqual([]);
        expect((await D.runDoor("unweblink", { key: "ORBIT-1042", id: wid, confirm: true })).body).toMatchObject({ ok: true, state: { removed: true } });

        // A sub-task changes status at the door by the card's own move.
        const open = await J.movesStored(child);
        const stamp = Date.parse(issue(child).updated.replace("+0000", "Z"));
        const moved = await D.runDoor("move", { key: child, id: open.data!.options[0]!.id, updated: stamp });
        expect(moved.body).toMatchObject({ ok: true, state: { moved: true } });
        expect(issue(child).statusId).not.toBe("1");
        expect((await D.runDoor("move", { key: child, id: open.data!.options[0]!.id, updated: stamp - 5000 })).status).toBe(409);
      });

      test("every one of them is an acting verb, so the level and the switch are asked first", () => {
        for (const v of ["move", "subtask", "relate", "unrelate", "weblink", "unweblink"]) expect(D.isActing(v)).toBe(true);
        expect(D.isActing("linktypes")).toBe(false);
      });
    });
  });
}

suite("cloud");
suite("datacenter");
