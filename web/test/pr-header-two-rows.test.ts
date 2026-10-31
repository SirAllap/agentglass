import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyLanes } from "../../shared/prFilter.ts";
import { PrFilterDeck } from "../src/components/PrFilterDeck.tsx";

/* The owner's header: the top bar and ONE row, where the saved views and the rules used to be two. */
const base = { filter: emptyLanes(), onChange() {}, rows: [], result: { kept: [], hiddenBy: new Map() } as never, fields: [], read: (() => "") as never, editing: null, setEditing() {} };
const html = (lead?: React.ReactNode) => renderToStaticMarkup(React.createElement(PrFilterDeck, { ...base, viewsRow: lead }));

describe("the saved views and the rules are one row", () => {
  test("the lead is inside the rules group, before the rules, and there is one row", () => {
    const out = html(React.createElement("span", { id: "views-lead" }, "Main"));
    const group = out.indexOf('role="group" aria-label="Your rules"');
    expect(group).toBeGreaterThan(-1);
    expect(out.indexOf("views-lead")).toBeGreaterThan(group);
    expect(out.indexOf("views-lead")).toBeLessThan(out.indexOf("Your rules</span>"));
    expect(out.match(/class="agx-drow"/g)?.length).toBe(1);
  });
  test("with no lead the row is the rules' own, as before", () => {
    expect(html()).not.toContain("agx-drow-sep");
  });
});
