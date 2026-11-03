/*
 * The Card skills card, drawn. It sits on the Agents page whether or not
 * ClickUp is connected, so it has to say something in both states and offer
 * its field before the read lands — a row that returns null left the note
 * under no control at all.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";
const mem = new Map<string, string>();
globalStubs()("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } });
const { CardSkillsCard } = await import("../src/components/ClickUpPane.tsx");

describe("Card skills on the Agents page", () => {
  test("with nothing connected it still draws its field, and says where the tracker's own default is", () => {
    const html = renderToStaticMarkup(React.createElement(CardSkillsCard, { connected: false }));
    expect(html).toContain("Card skills pattern");
    expect(html).toContain("Connect ClickUp under");
    expect(html).toContain("Open Connections");
    expect(html).not.toContain("Settings › Connections");
  });
  test("once connected, the note points at the ClickUp page it opens", () => {
    const html = renderToStaticMarkup(React.createElement(CardSkillsCard, { connected: true }));
    expect(html).toContain("The tracker’s own default lives on the");
    expect(html).toContain("Open ClickUp");
  });
});
