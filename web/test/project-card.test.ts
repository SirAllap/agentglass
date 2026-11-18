import { describe, expect, test } from "bun:test";
import type { GitRepoRef } from "../../shared/types.ts";
import { cardRows, cutPath, folderPreview, groupHead, groupOf, groupOrder, shelfIds, ageLabel, folderHue, multiMode, pickAction, tabScope, tileSub, GROUP_HIDDEN, GROUP_WORKTREES, folderKey } from "../src/lib/projectCard.ts";

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const repo = (root: string, touchedAt: number, extra: Partial<GitRepoRef> = {}): GitRepoRef =>
  ({ root, name: root.split("/").pop()!, branch: "main", dirty: 0, ahead: 0, behind: 0, touchedAt, ...extra }) as GitRepoRef;

describe("shelf", () => {
  test("newest first, three at most, last seven days only", () => {
    const repos = [repo("/h/a", NOW - 5 * H), repo("/h/b", NOW - H), repo("/h/c", NOW - 30 * H), repo("/h/d", NOW - 200 * H), repo("/h/e", NOW - 2 * H)];
    expect(shelfIds(repos, new Set(), NOW)).toEqual(["/h/b", "/h/e", "/h/a"]);
  });
  test("worktrees, hidden and never-touched stay off", () => {
    const repos = [repo("/h/a", NOW - H, { worktreeOf: "/h/x" }), repo("/h/b", NOW - H), repo("/h/c", 0), repo("/h/d", NOW - 2 * H)];
    expect(shelfIds(repos, new Set(["/h/b"]), NOW)).toEqual(["/h/d"]);
  });
});

describe("groups", () => {
  test("folder, worktrees, hidden (hidden wins)", () => {
    expect(groupOf(repo("/h/acme/api", 1), new Set())).toBe(folderKey("/h/acme"));
    expect(groupOf(repo("/h/wt/x", 1, { worktreeOf: "/h/acme/api" }), new Set())).toBe(GROUP_WORKTREES);
    expect(groupOf(repo("/h/wt/x", 1, { worktreeOf: "/h/acme/api" }), new Set(["/h/wt/x"]))).toBe(GROUP_HIDDEN);
  });
  test("order: current folder, then bigger, worktrees and hidden last", () => {
    const size = (k: string) => ({ a: 1, b: 5, c: 3, [GROUP_HIDDEN]: 9, [GROUP_WORKTREES]: 9 })[k] ?? 0;
    expect(groupOrder([GROUP_HIDDEN, "b", GROUP_WORKTREES, "a", "c"], "a", size)).toEqual(["a", "b", "c", GROUP_WORKTREES, GROUP_HIDDEN]);
  });
  test("head: folder name with a preview of children, cut at a name", () => {
    const h = groupHead(folderKey("/home/u/code/nimbus"), [{ label: "nimbus/web" }, { label: "nimbus/cli" }, { label: "nimbus/design-tokens" }], 16);
    expect(h.title).toBe("~/code/nimbus");
    expect(h.preview).toBe("web · cli…");
    expect(groupHead(GROUP_HIDDEN, [], 10)).toEqual({ title: "Hidden", preview: "" });
  });
  test("folderPreview fits whole", () => {
    expect(folderPreview(["a", "b"], 20)).toBe("a · b");
  });
});

describe("cut path", () => {
  test("short path is kept, home becomes ~", () => {
    expect(cutPath("/home/u/code/acme/api", 40)).toBe("~/code/acme/api");
  });
  test("the start is cut, the repo name never", () => {
    const out = cutPath("/home/u/code/acme/very/deep/billing-api", 24);
    expect(out.startsWith("…/")).toBe(true);
    expect(out.endsWith("/billing-api")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(24);
  });
  test("a name longer than the room stays whole", () => {
    expect(cutPath("/srv/x/a-very-long-repository-name-indeed", 12)).toBe("…/a-very-long-repository-name-indeed");
  });
});

test("cardRows: id is the root, sub is the cut path", () => {
  const [r] = cardRows([repo("/home/u/code/acme/api", NOW, { dirty: 3, branch: "dev" })], new Set());
  expect(r).toMatchObject({ id: "/home/u/code/acme/api", sub: "~/code/acme/api", branch: "dev", dirty: 3, at: NOW });
});

describe("projectCard: tiles, ticks, new tab", () => {
  const H = 3_600_000;
  test("age reads now, hours, yesterday, days", () => {
    const now = 100 * 86_400_000;
    expect(ageLabel(now - 59 * 60_000, now)).toBe("now");
    expect(ageLabel(now - H, now)).toBe("1h");
    expect(ageLabel(now - 30 * H, now)).toBe("yesterday");
    expect(ageLabel(now - 3 * 86_400_000, now)).toBe("3d");
  });
  test("tile sub joins age and branch", () => {
    expect(tileSub(0, "main", 2 * H)).toBe("2h · main");
    expect(tileSub(0, "", 2 * H)).toBe("2h");
  });
  test("multi-select shows for long lists or once ticked", () => {
    expect(multiMode(19, 0)).toBe(false);
    expect(multiMode(20, 0)).toBe(true);
    expect(multiMode(5, 1)).toBe(true);
  });
  test("folder colour is stable per project", () => {
    expect(folderHue("/a/orbit")).toBe(folderHue("/a/orbit"));
    expect(new Set(["/a/x", "/a/y", "/a/z", "/b/w", "/b/v", "/c/u"].map(folderHue)).size).toBeGreaterThan(1);
  });
  test("new tab adds to the open projects, never twice", () => {
    expect(tabScope("/b", ["/a"])).toEqual(["/a", "/b"]);
    expect(tabScope("/a", ["/a"])).toBeNull();
  });
});

describe("pickAction", () => {
  test("no ticks: the row opens on its own", () => {
    expect(pickAction(new Set(), "a")).toBe("choose");
  });
  test("ticks set: an unticked row toggles, a ticked row opens the set", () => {
    expect(pickAction(new Set(["a", "b"]), "c")).toBe("toggle");
    expect(pickAction(new Set(["a", "b"]), "a")).toBe("scope");
  });
});
