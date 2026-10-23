/*
 * A JIRA CARD ON A PULL REQUEST ROW, FROM CACHE ALONE.
 *
 * `cardFor` answered for ClickUp only, so a machine with just Jira got no
 * `PrSummary.card` on any row. It now answers for a Jira-owned key from the
 * Jira views cache, with the same rules the ClickUp half keeps: never a
 * request (no fake site is even started here, so a request would fail the
 * test), nothing once the credential is gone, nothing from a read older than
 * a day, and ClickUp's answer wins where it has one.
 *
 * Every file lives under a private temp dir; nothing touches the real config.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderTask, SavedView } from "../../shared/providers.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-jira-card-for-"));
const saved: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "AGENTGLASS_DB"]) saved[k] = process.env[k];
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "agx.db");

const C = await import("../src/credentials.ts");
const V = await import("../src/jiraviews.ts");
const CV = await import("../src/clickupviews.ts");
const { cardFor } = await import("../src/prs.ts");

const SITE = "acme.atlassian.net";
const view: SavedView = { id: "board:12", name: "Orbit board", url: "", addedAt: 0 };
const task = (key: string, extra: Partial<ProviderTask> = {}): ProviderTask => ({
  id: String(10000 + Number(key.split("-")[1])), customId: key, title: "Retry the export", url: `https://${SITE}/browse/${key}`,
  status: "In Review", statusKind: "open", priority: "high", due: null, updated: 1, tags: [], list: "Orbit", listId: key.split("-")[0],
  assignees: ["Ada Example"], people: [{ key: "u1", name: "Ada Example", initials: "AE" }], mine: false, ...extra,
}) as ProviderTask;

const connectJira = () => C.setCredential("jira", { token: "t0k", email: "ada@example.com", site: SITE, auth: "basic", account: "Ada Example" });
const readBoard = (tasks: ProviderTask[], at = Date.now()) => V.putCache(SITE, view.id, { view, tasks, columns: [], at });

beforeEach(() => {
  C.__clearAll();
  C.__setCredentialsPath(join(dir, "creds.json"));
  V.__setJiraViewsPath(join(dir, "jira-views.json"));
  V.__clear();
  V.addView(SITE, view);
});

afterAll(() => {
  C.__clearAll();
  C.__setCredentialsPath(null);
  V.__setJiraViewsPath(null);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

describe("the card line on a pull request, Jira only", () => {
  it("is drawn from a board read a minute ago, with the tracker named", () => {
    connectJira();
    readBoard([task("ORBIT-7"), task("ORBIT-1042")]);
    const c = cardFor("fix/ORBIT-1042-retry", "");
    expect(c).toMatchObject({ customId: "ORBIT-1042", status: "In Review", tracker: "jira", url: `https://${SITE}/browse/ORBIT-1042` });
    expect(c?.people?.[0]?.name).toBe("Ada Example");
  });

  it("reads a key with one digit, which the ClickUp reader never took for a card", () => {
    connectJira();
    readBoard([task("ORBIT-7")]);
    expect(cardFor("", "ORBIT-7 fix the export")?.customId).toBe("ORBIT-7");
  });

  it("reads a key that has a digit in its prefix", () => {
    connectJira();
    readBoard([task("AB2-12")]);
    expect(cardFor("feature/AB2-12-thing", "")?.customId).toBe("AB2-12");
  });

  it("reads a lower-case key in a branch and not in a title", () => {
    connectJira();
    readBoard([task("ORBIT-7")]);
    expect(cardFor("fix/orbit-7-export", "")?.customId).toBe("ORBIT-7");
    expect(cardFor("", "orbit-7 fix the export")).toBeUndefined();
  });

  it("does not take a longer number or a longer word for the key", () => {
    connectJira();
    readBoard([task("ORBIT-7")]);
    expect(cardFor("fix/ORBIT-70-x", "")).toBeUndefined();
    expect(cardFor("fix/XORBIT-7-x", "")).toBeUndefined();
  });

  it("says nothing for a key no cached board holds", () => {
    connectJira();
    readBoard([task("ORBIT-7")]);
    expect(cardFor("fix/ORBIT-8-x", "")).toBeUndefined();
  });

  it("says nothing once Jira is disconnected, whatever the cache still holds", () => {
    connectJira();
    readBoard([task("ORBIT-7")]);
    C.clearCredential("jira");
    expect(cardFor("fix/ORBIT-7-x", "")).toBeUndefined();
  });

  it("drops a reading older than a day, like the ClickUp half", () => {
    connectJira();
    readBoard([task("ORBIT-7")], Date.now() - 25 * 60 * 60_000);
    expect(cardFor("fix/ORBIT-7-x", "")).toBeUndefined();
  });

  it("prefers the freshest of two boards holding the same card", () => {
    connectJira();
    const other: SavedView = { id: "board:13", name: "Other board", url: "", addedAt: 0 };
    V.addView(SITE, other);
    V.putCache(SITE, other.id, { view: other, tasks: [task("ORBIT-7", { status: "Done" })], columns: [], at: Date.now() - 60_000 });
    readBoard([task("ORBIT-7", { status: "In Review" })]);
    expect(cardFor("fix/ORBIT-7-x", "")?.status).toBe("In Review");
  });
});

describe("with ClickUp connected too", () => {
  it("leaves ClickUp's answer alone when ClickUp holds the card", () => {
    connectJira();
    C.setCredential("clickup", { token: "pk_1_TEST", account: "Ada", workspace: "Orbit", workspaceId: "9001", accountId: "7" });
    const cu: SavedView = { id: "v1", name: "Sprint board", url: "https://app.clickup.com/1/v/l/v1", addedAt: 0 };
    CV.__setViewsPath(join(dir, "clickup-views.json"));
    CV.addView(cu);
    CV.putCache({ view: cu, tasks: [{ ...task("ORBIT-1042"), id: "86xaaa011", status: "in development" }], statuses: [], fields: [], at: Date.now() });
    readBoard([task("ORBIT-1042")]);
    const c = cardFor("fix/ORBIT-1042-x", "");
    expect(c?.id).toBe("86xaaa011");
    expect(c?.tracker).toBeUndefined();
    CV.__setViewsPath(null);
  });
});
