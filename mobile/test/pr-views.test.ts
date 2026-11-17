/*
 * The phone's copy of the board's saved views, against a fake computer.
 *
 * The list is the server's (`/prs/views`, validated by shared/prFilter.ts); what
 * is asserted here is the phone's half: it holds what the computer answered per
 * repository, a repository the computer never saved has none, a refused write
 * puts the previous list back, and which view is on stays on this phone.
 *
 * Fixtures are invented (`acme/orbit`), never a real repository or credential.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { emptyLanes, type PrView } from "../../shared/prFilter.ts";
import {
  __resetViews, __setViewsBackend, activeViewId, commitViews, loadViews, saveNewView, setActiveViewId, viewsCondition, viewsOf,
} from "../src/state/pr-views.ts";
import type { Host } from "../src/lib/host.ts";
import type { ViewsAnswer } from "../src/state/pr-views.ts";

const REPO = "acme/orbit";

const host = (token = "invented-token"): Host =>
  ({ origin: "http://127.0.0.1:4000", token, label: "phone", scope: "full", pairedAt: 0 });

const view = (id: string, name = id): PrView => {
  const filter = emptyLanes();
  filter.show.children.push({ id: "s1", field: "author", op: "is", values: ["ada"] });
  return { id, name, filter, order: 0 };
};

const rw = (get: (h: Host, repo: string) => Promise<ViewsAnswer>, put: (h: Host, repo: string, views: PrView[]) => Promise<ViewsAnswer>) => {
  __setViewsBackend({ get, put });
};

afterEach(() => __resetViews());

describe("the held list", () => {
  test("a repository the computer never saved a list for has no views", async () => {
    rw(async () => ({ ok: true, views: [], saved: false }), async () => ({ ok: false }));
    await loadViews(host(), REPO);
    expect(viewsOf(host(), REPO).views).toEqual([]);
    expect(viewsOf(host(), REPO).loading).toBe(false);
  });

  test("a saved list is held as the computer answered it", async () => {
    const saved = [view("qa", "Ready for QA"), view("mine")];
    rw(async () => ({ ok: true, views: saved, saved: true }), async () => ({ ok: false }));
    await loadViews(host(), REPO);
    expect(viewsOf(host(), REPO).views.map((v) => v.name)).toEqual(["Ready for QA", "mine"]);
  });

  test("a refused write puts the previous list back, and says why", async () => {
    const saved = [view("qa", "Ready for QA")];
    let written: PrView[] | null = null;
    rw(
      async () => ({ ok: true, views: saved, saved: true }),
      async (_h, _repo, views) => { written = views; return { ok: false, error: "repo must be owner/name" }; },
    );
    await loadViews(host(), REPO);
    const error = await commitViews(host(), REPO, [view("qa"), view("later")]);
    expect(written!.map((v) => v.id)).toEqual(["qa", "later"]);
    expect(error).toBe("repo must be owner/name");
    expect(viewsOf(host(), REPO).views.map((v) => v.id)).toEqual(["qa"]);
  });

  test("two refused writes queued together leave the server's list, not the first optimistic one", async () => {
    const saved = [view("qa", "Ready for QA")];
    rw(
      async () => ({ ok: true, views: saved, saved: true }),
      async () => ({ ok: false, error: "repo must be owner/name" }),
    );
    await loadViews(host(), REPO);
    const [a, b] = await Promise.all([
      commitViews(host(), REPO, [view("qa"), view("a")]),
      commitViews(host(), REPO, [view("qa"), view("b")]),
    ]);
    expect(a).toBe("repo must be owner/name");
    expect(b).toBe("repo must be owner/name");
    expect(viewsOf(host(), REPO).views.map((v) => v.id)).toEqual(["qa"]);
  });

  test("two refused writes with no confirmed read leave nothing, not the first optimistic list", async () => {
    // A read that never succeeded: `confirmed` is empty, so no list here was
    // ever the server's. Restoring the optimistic one would show views the
    // computer never accepted.
    rw(
      async () => ({ ok: false, error: "the computer did not answer" }),
      async () => ({ ok: false, error: "repo must be owner/name" }),
    );
    await loadViews(host(), REPO);
    const [a, b] = await Promise.all([
      commitViews(host(), REPO, [view("qa"), view("a")]),
      commitViews(host(), REPO, [view("qa"), view("b")]),
    ]);
    expect(a).toBe("repo must be owner/name");
    expect(b).toBe("repo must be owner/name");
    expect(viewsOf(host(), REPO).views).toEqual([]);
  });

  test("a read that failed is asked again rather than remembered as an empty list", async () => {
    let down = true;
    rw(
      async () => (down ? { ok: false, error: "the computer did not answer" } : { ok: true, views: [view("qa")], saved: true }),
      async () => ({ ok: false }),
    );
    await loadViews(host(), REPO);
    expect(viewsOf(host(), REPO).views).toEqual([]);
    down = false;
    await loadViews(host(), REPO);
    expect(viewsOf(host(), REPO).views.map((v) => v.id)).toEqual(["qa"]);
  });

  test("loading, empty and failed are three conditions, not three empty lists", async () => {
    let down = true;
    let answer: ViewsAnswer | null = null;
    rw(
      async () => (down ? { ok: false, error: "the computer did not answer" } : answer!),
      async () => ({ ok: false }),
    );
    const asked = loadViews(host(), REPO);
    expect(viewsCondition(viewsOf(host(), REPO))).toBe("loading");
    await asked;
    expect(viewsCondition(viewsOf(host(), REPO))).toBe("failed");
    down = false;
    answer = { ok: true, views: [], saved: false };
    await loadViews(host(), REPO, true);
    expect(viewsCondition(viewsOf(host(), REPO))).toBe("empty");
    answer = { ok: true, views: [view("qa")], saved: true };
    await loadViews(host(), REPO, true);
    expect(viewsCondition(viewsOf(host(), REPO))).toBe("ready");
  });

  test("a forced read picks up a view the desk saved while this phone was open", async () => {
    let saved = [view("qa", "Ready for QA")];
    rw(
      async () => ({ ok: true, views: saved, saved: true }),
      async () => ({ ok: false }),
    );
    await loadViews(host(), REPO);
    expect(viewsOf(host(), REPO).views.map((v) => v.id)).toEqual(["qa"]);
    saved = [view("qa", "Ready for QA"), view("later", "Later")];
    await loadViews(host(), REPO, true);
    expect(viewsOf(host(), REPO).views.map((v) => v.id)).toEqual(["qa", "later"]);
  });
});

describe("this phone's own", () => {
  test("each computer keeps its own list and its own lit view", async () => {
    const one = host("invented-one");
    const two = host("invented-two");
    rw(
      async (h) => ({ ok: true, views: h.token === one.token ? [view("qa")] : [], saved: h.token === one.token }),
      async () => ({ ok: false }),
    );
    await loadViews(one, REPO);
    await loadViews(two, REPO);
    expect(viewsOf(one, REPO).views).toHaveLength(1);
    expect(viewsOf(two, REPO).views).toHaveLength(0);

    setActiveViewId(one, REPO, "qa");
    expect(activeViewId(one, REPO)).toBe("qa");
    expect(activeViewId(two, REPO)).toBeNull();
    setActiveViewId(one, REPO, null);
    expect(activeViewId(one, REPO)).toBeNull();
  });
});

describe("the sheet says which read it had", () => {
  test("loading, empty and failed are three sentences, and a failed read offers a retry", async () => {
    const sheet = await Bun.file(new URL("../src/review/PrFilterSheet.tsx", import.meta.url)).text();
    expect(sheet).toContain("Reading this repository’s views…");
    expect(sheet).toContain("The desk has not saved a view for this repository.");
    expect(sheet).toContain("the views could not be read · try again");
    expect(sheet).toContain("onRetryViews?.()");
  });

  test("the reading line stays over a held list being re-read", async () => {
    // A forced read over the chips already on screen is still a read running:
    // a view deleted on the desk must not stay tappable in silence.
    const sheet = await Bun.file(new URL("../src/review/PrFilterSheet.tsx", import.meta.url)).text();
    expect(sheet).toContain('{viewsCondition === "loading" || viewsCondition === "idle" ? (');
    expect(sheet).not.toContain('"idle") && !views?.length');
  });

  test("a view the desk removed is named, and what the active view hid is counted", async () => {
    const sheet = await Bun.file(new URL("../src/review/PrFilterSheet.tsx", import.meta.url)).text();
    expect(sheet).toContain("The view this phone had on is no longer saved on the desk.");
    expect(sheet).toContain("hidden by this view");
  });
});

describe("saveNewView", () => {
  afterEach(() => __resetViews());
  test("re-reads the desk's list, appends, writes the whole list, and turns the view on", async () => {
    const desk = [view("d1", "Main")];
    let wrote: PrView[] = [];
    rw(async () => ({ ok: true, views: desk, saved: true }), async (_h, _r, v) => { wrote = v; return { ok: true, views: v }; });
    expect(await saveNewView(host(), REPO, "Release", { drafts: true, bots: false })).toBeNull();
    expect(wrote.map((v) => v.name)).toEqual(["Main", "Release"]);
    expect(wrote[1]!.order).toBe(1);
    expect(activeViewId(host(), REPO)).toBe(wrote[1]!.id);
  });
  test("a computer that does not answer saves nothing; a taken name says so", async () => {
    let puts = 0;
    rw(async () => ({ ok: false, error: "down" }), async () => { puts++; return { ok: true }; });
    expect(await saveNewView(host(), REPO, "Release", { drafts: true, bots: true })).toContain("did not answer");
    rw(async () => ({ ok: true, views: [view("d1", "Main")] }), async () => { puts++; return { ok: true }; });
    expect(await saveNewView(host(), REPO, "main", { drafts: true, bots: true })).toContain("exists");
    expect(puts).toBe(0);
  });
});
