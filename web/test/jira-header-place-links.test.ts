/*
 * The space and the epic in a Jira card's header are buttons that load that place in the main view.
 * Read from source where there is no renderer; the pieces that are plain functions are called directly.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement } from "react";
import type { ProviderTask } from "../../shared/providers.ts";
import { PlaceLink, placeOf } from "../src/components/jira/detail/DetailHeader.tsx";

const SRC = join(import.meta.dir, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

const card = (over: Partial<ProviderTask> = {}) => ({
  id: "ORBIT-1042", customId: "ORBIT-1042", title: "Offboard", list: "Orbit Platform", listId: "ORBIT",
  parent: { key: "ORBIT-7", title: "Account offboarding", type: "Epic" }, ...over,
}) as ProviderTask;

describe("what the path line links", () => {
  test("a card under an epic has a space target and an epic target", () => {
    const p = placeOf(card(), undefined);
    expect(p.space).toEqual({ name: "Orbit Platform", key: "ORBIT" });
    expect(p.epic).toEqual({ name: "Account offboarding", key: "ORBIT-7" });
  });
  test("a card with no epic links only the space", () => {
    const p = placeOf(card({ parent: undefined }), undefined);
    expect(p.space?.key).toBe("ORBIT");
    expect(p.epic).toBeUndefined();
  });
});

describe("PlaceLink", () => {
  test("is one focusable button per place, and plain text without a handler", () => {
    const two = renderToStaticMarkup(createElement("div", null,
      createElement(PlaceLink, { name: "Orbit Platform", tip: "t", onOpen: () => undefined }),
      createElement(PlaceLink, { name: "Account offboarding", tip: "t", onOpen: () => undefined })));
    expect(two.match(/<button type="button"/g)?.length).toBe(2);
    const none = renderToStaticMarkup(createElement(PlaceLink, { name: "Orbit Platform", tip: "t" }));
    expect(none).not.toContain("<button");
  });
  test("clicking calls the handler it was given", () => {
    let hit = 0;
    const el = PlaceLink({ name: "Orbit Platform", tip: "t", onOpen: () => { hit += 1; } }) as ReactElement<{ onClick: () => void }>;
    el.props.onClick();
    expect(hit).toBe(1);
  });
  test("uses data-tip, never title=", () => {
    const html = renderToStaticMarkup(createElement(PlaceLink, { name: "Orbit Platform", tip: "t", onOpen: () => undefined }));
    expect(html).toContain("data-tip");
    expect(html).not.toContain("title=");
  });
});

describe("the wiring reuses the sidebar's and the palette's own doors", () => {
  const list = read("components/jira/list/JiraListView.tsx");
  test("a space is the tree's scope id sent through onSelect; an epic is its own scope page, not the open view narrowed to it", () => {
    expect(list).toContain('scopeIdOf({ kind: "space", space })');
    expect(list).toContain("onSelect?.({ viewId: id })");
    expect(list).toContain('scopeIdOf({ kind: "epic", space, epic }');
    const body = list.slice(list.indexOf("const openEpic"), list.indexOf("}, [onSelect, onFilters]);"));
    expect(body.indexOf("onSelect?.({ viewId: id })")).toBeGreaterThan(-1);
    expect(body.indexOf("onSelect?.({ viewId: id })")).toBeLessThan(body.indexOf("onFilters("));
    expect(list).toContain("onOpenSpace={openSpace} onOpenEpic={openEpic}");
  });
  test("the handlers travel dock -> card -> header", () => {
    expect(read("components/jira/list/JiraDock.tsx")).toContain("onOpenSpace={onOpenSpace} onOpenEpic={onOpenEpic}");
    expect(read("components/jira/JiraCard.tsx")).toContain("onOpenSpace={onOpenSpace} onOpenEpic={onOpenEpic}");
  });
});
