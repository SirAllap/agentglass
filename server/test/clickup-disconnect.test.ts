/*
 * A DISCONNECT FORGETS WHAT THE TOKEN READ.
 *
 * Disconnect used to clear the credential and the in-memory list and nothing
 * else. The boards' cached tasks, the card watch's last-seen map and the two
 * search tables stayed, and the pull request list went on drawing a card from
 * them for up to a day with no credential to read it by. Measured by running
 * the old order: cardFor("ORBIT-1042-x") still answered after the disconnect.
 *
 * Every file here lives under a private temp dir; nothing touches the real
 * config directory.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderTask, SavedView } from "../../shared/providers.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-cudisc-"));
const C = await import("../src/credentials.ts");
const V = await import("../src/clickupviews.ts");
const W = await import("../src/clickupwatch.ts");
const I = await import("../src/clickupindex.ts");
const P = await import("../src/providers.ts");
const { cardFor } = await import("../src/prs.ts");

const viewsFile = join(dir, "clickup-views.json");
const watchFile = join(dir, "clickup-watch.json");
const view: SavedView = { id: "v1", name: "Sprint board", url: "https://app.clickup.com/1/v/l/v1", addedAt: 0 };
const task = {
  id: "86xaaa011", customId: "ORBIT-1042", title: "Pagination arrows", url: "", status: "in development",
  statusKind: "active", priority: null, due: null, updated: 0, tags: [], list: null, assignees: [], mine: false,
} as unknown as ProviderTask;

beforeEach(() => {
  C.__setCredentialsPath(join(dir, "credentials.json"));
  V.__setViewsPath(viewsFile);
  W.__setWatchPath(watchFile);
  C.setCredential("clickup", { token: "pk_1_TEST", account: "Ada", workspace: "Orbit", workspaceId: "9001", accountId: "7" });
  V.addView(view);
  V.putCache({ view, tasks: [task], statuses: [], fields: [], at: Date.now() });
  writeFileSync(watchFile, JSON.stringify({ seen: { [task.id]: { status: "open", title: "x" } }, at: 1 }));
  W.__setWatchPath(watchFile);
  I.remember([{ ...task, body: "" } as never]);
});

afterAll(() => {
  C.__setCredentialsPath(null);
  V.__setViewsPath(null);
  W.__setWatchPath(null);
  I.forget();
  rmSync(dir, { recursive: true, force: true });
});

describe("the card line on a pull request", () => {
  it("is drawn from a board while connected", () => {
    expect(cardFor("fix/ORBIT-1042-pagination", "")?.customId).toBe("ORBIT-1042");
  });

  it("is gone the moment the credential is, even if the cache were not cleared", () => {
    C.clearCredential("clickup");
    expect(cardFor("fix/ORBIT-1042-pagination", "")).toBeUndefined();
  });

  it("takes no version string for a card", () => {
    for (const b of ["fix/utf-8-decode", "chore/gpt-4-prompt", "perf/sha-256"]) {
      expect(cardFor(b, "")).toBeUndefined();
    }
  });
});

describe("disconnecting ClickUp", () => {
  it("drops the cached tasks, the watch file and both tables, and keeps the boards", async () => {
    await P.disconnectProvider("clickup");
    expect(cardFor("ORBIT-1042-x", "")).toBeUndefined();
    expect(V.cachedFor("v1")).toBeFalsy();
    expect(existsSync(watchFile)).toBe(false);
    expect(I.indexed().cards).toBe(0);
    expect(V.savedViews().some((v) => v.id === "v1")).toBe(true);
  });

  it("forgets the saved boards too when asked: the file is gone", async () => {
    await P.disconnectProvider("clickup", { forgetBoards: true });
    expect(existsSync(viewsFile)).toBe(false);
    expect(existsSync(watchFile)).toBe(false);
    expect(V.savedViews().some((v) => v.id === "v1")).toBe(false);
  });

  it("leaves another provider's data alone", async () => {
    await P.disconnectProvider("github");
    expect(existsSync(watchFile)).toBe(true);
    expect(I.indexed().cards).toBe(1);
  });
});
