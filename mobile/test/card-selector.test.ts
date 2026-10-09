/*
 * The list selector's decisions: which boards the phone already holds, how the
 * workspace's spaces, folders and lists unfold, and what tapping a list does.
 *
 * The shapes are what /clickup/views, /clickup/spaces and /clickup/folders
 * answer, with invented names.
 */
import { describe, expect, test } from "bun:test";
import { ASSIGNED_VIEW_ID, type SavedView } from "../../shared/providers.ts";
import {
  boardEntries, boardPath, listTarget, matchSpaces, spaceTree, type FolderShape,
} from "../src/model/cardSelector.ts";

const view = (over: Partial<SavedView> & { id: string; name: string }): SavedView => ({ url: "", addedAt: 1, ...over });

const views: SavedView[] = [
  view({ id: ASSIGNED_VIEW_ID, name: "Assigned to me", builtin: true }),
  view({ id: "v-sprint", name: "Sprint board", listId: "9001", spaceName: "Orbit", folderName: "Delivery" }),
  view({ id: "v-backlog", name: "Backlog board", listId: "9002", spaceName: "Orbit" }),
  view({ id: "v-inbox", name: "Support inbox", listId: "9100", spaceName: "Platform" }),
  view({ id: "v-pasted", name: "Pasted board" }),
];

describe("path", () => {
  test("space over folder, from where the list sits, else from what was saved", () => {
    expect(boardPath(views[1], undefined)).toBe("Orbit / Delivery");
    expect(boardPath(views[2], undefined)).toBe("Orbit");
    expect(boardPath(views[1], { space: "Engineering", folder: "Orbit", list: "Orbit Sprint" })).toBe("Engineering / Orbit");
    expect(boardPath(views[4], undefined)).toBe("");
    expect(boardPath(undefined, undefined)).toBe("");
  });
});

describe("saved boards", () => {
  test("Assigned to me stands apart and the rest group under their space, in the order saved", () => {
    const e = boardEntries(views, "v-sprint", "");
    expect(e.assigned?.id).toBe(ASSIGNED_VIEW_ID);
    expect(e.groups.map((g) => [g.heading, g.entries.map((x) => x.id)])).toEqual([
      ["Orbit", ["v-sprint", "v-backlog"]],
      ["Platform", ["v-inbox"]],
      ["Saved boards", ["v-pasted"]],
    ]);
  });
  test("the current one is marked, once", () => {
    const e = boardEntries(views, "v-backlog", "");
    expect(e.groups.flatMap((g) => g.entries).filter((x) => x.on).map((x) => x.id)).toEqual(["v-backlog"]);
    expect(boardEntries(views, ASSIGNED_VIEW_ID, "").assigned?.on).toBe(true);
  });
  test("an entry carries its path as the second line", () => {
    expect(boardEntries(views, null, "").groups[0]!.entries[0]!.path).toBe("Orbit / Delivery");
  });
  test("search narrows by name or path and drops a group left empty", () => {
    const e = boardEntries(views, null, "delivery");
    expect(e.groups.map((g) => g.heading)).toEqual(["Orbit"]);
    expect(e.groups[0]!.entries.map((x) => x.id)).toEqual(["v-sprint"]);
    expect(e.assigned).toBeNull();
    expect(boardEntries(views, null, "assigned").assigned).not.toBeNull();
  });
});

const spaces = [{ id: "90010", name: "Engineering" }, { id: "90011", name: "Platform" }];
describe("spaces", () => {
  test("search narrows them by name", () => {
    expect(matchSpaces(spaces, "")).toHaveLength(2);
    expect(matchSpaces(spaces, "plat").map((s) => s.id)).toEqual(["90011"]);
  });
});

const folders: FolderShape[] = [
  { id: "f1", name: "Delivery", lists: [{ id: "9001", name: "Sprint board", tasks: 14 }, { id: "9003", name: "Release train", tasks: 5 }] },
  { id: "f2", name: "Research", lists: [{ id: "9200", name: "Notes" }] },
  { id: "90010", name: "Lists in this space", folderless: true, lists: [{ id: "9002", name: "Backlog board", tasks: 32 }] },
];

describe("the tree of a space", () => {
  test("folders closed show only themselves; a folderless list sits at the top level with no folder row", () => {
    const rows = spaceTree(folders, new Set(), views, null, "");
    expect(rows.map((r) => `${r.kind}:${r.kind === "folder" ? r.name : r.name}:${r.kind === "list" ? r.depth : ""}`)).toEqual([
      "folder:Delivery:", "folder:Research:", "list:Backlog board:0",
    ]);
  });
  test("an open folder lists its lists one level in, with the counts the server gave", () => {
    const rows = spaceTree(folders, new Set(["f1"]), views, null, "");
    expect(rows.map((r) => r.kind === "folder" ? `F ${r.name} ${r.open}` : `L ${r.name} ${r.depth} ${r.tasks ?? "-"}`)).toEqual([
      "F Delivery true", "L Sprint board 1 14", "L Release train 1 5", "F Research false", "L Backlog board 0 32",
    ]);
  });
  test("a list already on the phone is marked with its board, and as current only when it is the open one", () => {
    const rows = spaceTree(folders, new Set(["f1"]), views, "v-sprint", "");
    const lists = rows.filter((r) => r.kind === "list");
    expect(lists.map((r) => [r.name, r.viewId, r.on])).toEqual([["Sprint board", "v-sprint", true], ["Release train", null, false], ["Backlog board", "v-backlog", false]]);
  });
  test("searching opens every folder and keeps only what matches, a folder's name keeping all its lists", () => {
    const byList = spaceTree(folders, new Set(), views, null, "release");
    expect(byList.map((r) => r.name)).toEqual(["Delivery", "Release train"]);
    const byFolder = spaceTree(folders, new Set(), views, null, "research");
    expect(byFolder.map((r) => r.name)).toEqual(["Research", "Notes"]);
    expect(spaceTree(folders, new Set(), views, null, "zzz")).toEqual([]);
  });
});

describe("tapping a list", () => {
  test("a list the phone already has a board for opens it, costing nothing", () => {
    expect(listTarget("9001", views)).toEqual({ view: "v-sprint" });
  });
  test("a list it has not is added first, as the desk's 'the list itself' does", () => {
    expect(listTarget("9003", views)).toEqual({ add: "9003" });
  });
  test("a pasted board with no list never answers for a list", () => {
    expect(listTarget("undefined", views)).toEqual({ add: "undefined" });
  });
});
