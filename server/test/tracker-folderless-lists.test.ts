/*
 * A SPACE HOLDS TWO KINDS OF THING, and we were only asking for one.
 *
 * The tracker's own sidebar draws folders and, below them as peers, the lists
 * that sit directly in the space. Its API splits those across two endpoints:
 * `/space/{id}/folder` returns the folders and says nothing at all about the
 * loose lists. This asked for folders only.
 *
 * Measured on a real workspace before writing this: five loose lists in one
 * space, the largest holding 1,390 tasks, none of them reachable from the
 * picker. The reported symptom was "I cannot find it from here", which is an
 * exact description of asking the wrong endpoint.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/clickup.ts", import.meta.url).pathname, "utf8");
const web = readFileSync(new URL("../../web/src/components/TasksPanel.tsx", import.meta.url).pathname, "utf8");
const providers = readFileSync(new URL("../src/providers.ts", import.meta.url).pathname, "utf8");

const folders = (() => {
  const at = src.indexOf("export async function clickupFolders(");
  expect(at).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf("\n}\n", at));
})();

describe("both endpoints, or the loose lists are invisible", () => {
  test("it asks for the folders AND the lists", () => {
    expect(folders).toMatch(/\/folder\?archived=false/);
    expect(folders).toMatch(/\/list\?archived=false/);
  });

  test("in parallel — they are independent and somebody is waiting", () => {
    expect(folders).toContain("await Promise.all([");
  });

  test("a failed second call still returns the folders", () => {
    /* Most of the answer is better than none: a space whose loose lists could
       not be read is still a space with folders in it. */
    expect(folders).toContain("loose.ok ? loose.data?.lists ?? [] : []");
  });
});

describe("they arrive as one pseudo-folder, not as a second shape", () => {
  test("everything downstream is built around 'a folder has lists'", () => {
    expect(folders).toContain("folderless: true");
    expect(folders).toContain("strays.length ?");
  });

  test("and the UI unpacks it rather than drawing the wrapper", () => {
    /* The wrapper is a transport shape, not a thing to show. Drawn as itself
       it read "Lists in this space 5", which hides the one list somebody came
       for — see the picker test below. The marker's only job is to tell the
       UI which entry to unpack. */
    expect(web).toContain("f.folderless ?");
    expect(web).toContain("sitting directly in this space");
  });
});

describe("the slug view id, which is the common one", () => {
  test("it is recognised as a view rather than refused", () => {
    /* `dm84m-3308037` — a short workspace-wide prefix, a hyphen, digits. The
       parser only knew `6-901700123456-1`, so every address of this shape was
       refused as "that does not look like a ClickUp board address". Which it
       plainly was: it is what the browser's bar shows when you open a list.

       I first measured this as a 404 and built a whole "the API does not know
       it" branch on the strength of one reading. The API answers 200 for it,
       three times out of three. The lesson is in the comment beside the
       pattern; the guard is here. */
    expect(src).toContain("SLUG_VIEW_ID");
    expect(src).toContain("SLUG_VIEW_ID.test(seg)");
  });

  test("it carries no list id inside it, unlike the older shape", () => {
    expect(src).toContain('if (SLUG_VIEW_ID.test(id) && !VIEW_ID.test(id)) return { workspaceId, kind: "view", viewId: id };');
  });

  test("a bare list id resolves too — the picker sends one", () => {
    /* A list with no folder around it has no address but its id, so that is
       what the picker sends. */
    expect(src).toContain('if (!text.includes("/") && LIST_ID.test(text)) return { kind: "list", listId: text };');
  });
});

describe("a list is a place that holds boards", () => {
  test("clicking one opens its views instead of adding it", () => {
    /* Measured on a real list: twenty-six views, four named some variant of
       the list's own name, and the one its owner works from every day called
       the same thing the list is. "Add the list" gets whichever view the
       tracker treats as default, which is none of those — and that is the
       whole reported problem: the address he pasted WAS the view he needed,
       and the menu could only offer him the list. */
    expect(web).toContain("setOpenList(openList === row.list!.id");
    expect(web).toContain("<ListViews listId={openList}");
  });

  test("it reuses the endpoint the sidebar already had", () => {
    /* The sidebar has hung views under a list for as long as it has had one.
       A second way to ask the same question is a second thing to keep right. */
    expect(web).toContain("api.clickupListViews(listId)");
  });

  test("the list itself stays a choice", () => {
    /* Sometimes the default view IS what somebody wants, and removing the old
       behaviour to make room for the new one is how a fix becomes a
       regression. */
    expect(web).toContain('onPick(listId)');
    expect(web).toContain("the list itself");
  });

  test("and the views it cannot draw are named, not hidden", () => {
    /* A Gantt or a dashboard is a real view. A picker that silently omits
       thirteen of twenty-six and looks complete is worse than one that says
       what it left out. */
    expect(web).toContain("more this app cannot draw");
  });
});

describe("a loose list is added on its own", () => {
  test("the picker draws them individually, not gathered behind one chip", () => {
    /* Gathered, the chip read "Lists in this space 5" — which answers "where
       is the one I want?" with "somewhere in here". The tracker's own sidebar
       draws them as peers below the folders, each with its count. */
    expect(web).toContain("f.folderless ? f.lists.map((l) => ({ list: l })) : [{ folder: f }]");
    /* The chip opens the list's views rather than adding it — see the block
       above for why. What this guards is that each loose list is its OWN row,
       which is what makes one findable among five. */
    expect(web).toContain("row.list!.id");
  });

  test("and it carries the task count the tracker itself shows", () => {
    expect(folders).toContain("task_count");
    expect(web).toContain("row.list.tasks");
  });
});
