/*
 * One icon for the machine.
 *
 * Ports and Resources were two rail buttons that opened the same panel on two
 * of its tabs. The icon left is Resources; a second one would put the pair
 * back and make the rail claim the machine is two destinations. Read from the
 * rendered rail and from its source, because the duplicate is exactly a
 * second `onMachine` call — nothing about the panel's own tabs, which stay.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";
const stubGlobal = globalStubs();

const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);
// views.ts asks desktop.ts whether there is a browser, and desktop.ts reads
// `location` at module scope.
stubGlobal("location", new URL("http://localhost:5173/"));

const { ViewRail } = await import("../src/components/workspace/ViewRail.tsx");

describe("the rail's machine cluster", () => {
  test("draws one icon for the view and names what the panel covers", async () => {
    const html = renderToStaticMarkup(React.createElement(ViewRail, {
      view: "git", onSelect() {}, onSkills() {}, onSettings() {}, onMachine() {},
    }));

    const labels = [...html.matchAll(/aria-label="(Ports|Resources)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["Resources"]);

    const tip = /aria-label="Resources" data-tip="([^"]*)"/.exec(html)?.[1];
    expect(tip).toContain("listening ports");
    expect(tip).toContain("locks");
    expect(tip).toContain("left-behind processes");

    // A second icon for the same panel would be a second call. The panel's own
    // Ports / Locks tabs are inside MachinePanel and are not this.
    const src = (await Bun.file(new URL("../src/components/workspace/ViewRail.tsx", import.meta.url)).text())
      .replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(src.match(/onMachine\(/g) ?? []).toHaveLength(1);
  });
});
