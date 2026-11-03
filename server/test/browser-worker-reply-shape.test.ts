/*
 * A WORKER'S REPLY IS SCOPED BY SHAPE, NOT BY A CONTAINER IT EXPECTS.
 *
 * The panel answers `tabs` with `tabs.list()` — a bare array. A filter written
 * against `{ tabs: [...] }` never ran on it, so a worker read every title and
 * URL in the window. The fixtures here come from the panel's own reply
 * builders (`serveTabsForTest`), so a change to the shape the panel really
 * sends breaks this file instead of leaving the guard untested.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  noteWorkerPage, resetWorkerPages, whoamiValue, workerReply,
} from "../src/browserdrive.ts";
import {
  closedReply, openedReply, selectedReply, tabsReply, type TabRow,
} from "../../shared/browserTabReplies.ts";
import { agentContainerName } from "../../shared/workerContainer.ts";

const OWN = "orbit-1";
const OWN_PAGE = "t9-own";
const PERSON = { id: "t1-personal", title: "Bank", url: "https://bank.example/", active: true, profile: "default" };
const OTHER = { id: "t4-other", title: "Other agent", url: "https://other.example/", active: false, profile: "orbit-two" };
const MINE = { id: OWN_PAGE, title: "Orbit", url: "https://orbit.example/", active: false, profile: agentContainerName(OWN) };

/** The panel's own answers, built by the function it calls. */
function panel(rows: TabRow[] = [MINE, PERSON, OTHER]) {
  const list = () => rows;
  return (op: string) => {
    switch (op) {
      case "tabs": return tabsReply(list());
      case "tab": return selectedReply(list(), list().find((r) => r.id === OWN_PAGE));
      case "closetab": return closedReply(list());
      default: return openedReply({ id: OWN_PAGE }, list());
    }
  };
}

beforeEach(() => {
  resetWorkerPages();
  noteWorkerPage(OWN, OWN_PAGE);
});

describe("a reply is filtered whatever shape the panel answered in", () => {
  test("the array `tabs` really sends keeps only the worker's own page", async () => {
    const ask = panel();
    const reply = await ask("tabs");
    expect(Array.isArray(reply.value)).toBe(true);
    const scoped = workerReply(OWN, { ok: true, value: reply.value });
    expect(scoped.value).toEqual([MINE]);
    expect(JSON.stringify(scoped.value)).not.toContain("bank.example");
  });

  test("`tab` and `closetab` carry the same list and are filtered the same", async () => {
    const ask = panel();
    for (const op of ["tab", "closetab"]) {
      const reply = ask(op);
      const scoped = workerReply(OWN, { ok: true, value: reply.value }) as { value: Array<{ id: string }> };
      expect({ op, ids: scoped.value.map((r) => r.id) }).toEqual({ op, ids: [OWN_PAGE] });
    }
  });

  test("`open` folds the list into an object, and that list is filtered too", async () => {
    const ask = panel();
    const reply = ask("open");
    const scoped = workerReply(OWN, { ok: true, value: reply.value }) as { value: { tabs: Array<{ id: string }> } };
    expect(scoped.value.tabs.map((r) => r.id)).toEqual([OWN_PAGE]);
  });

  test("the object shape `{tab, tabs}` is filtered as well", () => {
    const scoped = workerReply(OWN, {
      ok: true,
      value: { tab: PERSON.id, tabs: [PERSON, MINE, OTHER] },
    }) as { value: { tab: string | null; tabs: Array<{ id: string }> } };
    expect(scoped.value.tabs.map((r) => r.id)).toEqual([OWN_PAGE]);
    expect(scoped.value.tab).toBeNull();
  });

  test("whoami's nested answer loses a foreign active tab, built by the relay itself", async () => {
    const ask = panel();
    const reply = await ask("tabs");
    const value = whoamiValue({ identity: OWN, tab: PERSON.id }, reply.value);
    const scoped = workerReply(OWN, { ok: true, value }) as {
      value: { you: { tab: string | null; tabLive: boolean }; activeTab: unknown };
    };
    expect(scoped.value.activeTab).toBeNull();
    expect(scoped.value.you.tab).toBeNull();
    expect(scoped.value.you.tabLive).toBe(false);
  });

  test("an own active tab survives the same walk", async () => {
    const ask = panel([{ ...MINE, active: true }, PERSON]);
    const reply = await ask("tabs");
    const scoped = workerReply(OWN, {
      ok: true,
      value: whoamiValue({ identity: OWN, tab: OWN_PAGE }, reply.value),
    }) as { value: { you: { tabLive: boolean }; activeTab: { id: string } | null } };
    expect(scoped.value.you.tabLive).toBe(true);
    expect(scoped.value.activeTab?.id).toBe(OWN_PAGE);
  });

  test("an entry with a page field and no own id is dropped at any depth", () => {
    const scoped = workerReply(OWN, {
      ok: true,
      value: { tabs: [MINE, { title: "no id, not mine" }, { id: 7, url: "https://x.example/" }] },
    }) as { value: { tabs: Array<{ id: string }> } };
    expect(scoped.value.tabs.map((r) => r.id)).toEqual([OWN_PAGE]);
  });

  test("garbage and unknown top-level shapes become an empty list", () => {
    for (const value of ["tabs", 7, null, { count: 3 }, { rows: [PERSON] }]) {
      expect(workerReply(OWN, { ok: true, value }).value).toEqual([]);
    }
  });

  test("a failed reply is passed through with no list invented", () => {
    const reply = { ok: false, error: "no window" };
    expect(workerReply(OWN, reply)).toEqual(reply);
  });
});
