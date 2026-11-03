/*
 * The stylesheet and the markup, checked against each other. A `hidden` tabpanel that
 * still paints and a selection ring keyed on an attribute nobody emits are both
 * invisible to a test that reads either file alone, so these compute the pair:
 * the rule that wins for the element the page renders, and the attribute a rule
 * keys on against the one the drawing actually writes.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal";
globalStubs()("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
const { OrchestrationView } = await import("../src/components/orchestration/OrchestrationPane.tsx");
import type { OrchestrationViewProps } from "../src/components/orchestration/OrchestrationPane.tsx";
import { agentProvider } from "../../shared/agentKinds.ts";
import { composePolicy, defaultStored, type Policy } from "../../shared/orchestration.ts";
import type { EngineReadiness } from "../../shared/types.ts";

const CSS = readFileSync(join(import.meta.dir, "..", "src", "components", "orchestration", "orchestration.css"), "utf8");

interface Rule { sel: string; decls: Record<string, string> }
interface El { tag: string; classes: string[]; attrs: Record<string, string> }

/** Every style rule in a sheet, at-rules unwrapped: the media head is not part of a selector. */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const walk = (s: string) => {
    let i = 0;
    for (;;) {
      const open = s.indexOf("{", i);
      if (open < 0) return;
      const head = s.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < s.length && depth > 0) {
        if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
        j++;
      }
      const body = s.slice(open + 1, j - 1);
      if (head.startsWith("@")) walk(body);
      else if (head) {
        const decls: Record<string, string> = {};
        for (const d of body.split(";")) {
          const at = d.indexOf(":");
          if (at > 0) decls[d.slice(0, at).trim()] = d.slice(at + 1).trim();
        }
        out.push({ sel: head, decls });
      }
      i = j;
    }
  };
  walk(text);
  return out;
}

/** A pseudo that is a state of the pointer or the keyboard, which a rendered element does not carry. */
const STATE = /^(?::(?:hover|active|focus|focus-visible|focus-within|disabled|checked|empty))+$/;

/**
 * A compound selector's specificity and whether it holds, or null for a rule
 * about another element. A selector this test cannot weigh throws, so a new
 * shape in the sheet cannot be skipped in silence.
 */
function weigh(sel: string, el: El): [number, number, number] | null {
  const s = sel.trim();
  if (!s || /[\s>+~]/.test(s)) return null;
  const tok = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+|\[[\w-]+(?:=(?:"[^"]*"|'[^']*'))?\])*)(.*)$/.exec(s);
  if (!tok) throw new Error(`this test cannot weigh the selector ${s}`);
  let holds = true;
  const spec: [number, number, number] = [0, 0, 0];
  if (tok[1]) {
    spec[2]++;
    holds = tok[1].toLowerCase() === el.tag;
  }
  for (const part of tok[2]!.matchAll(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    spec[1]++;
    if (part[1]) holds &&= el.classes.includes(part[1]);
    else {
      const value = el.attrs[part[2]!];
      holds &&= value !== undefined && (part[3] === undefined || value === part[3]);
    }
  }
  const tail = tok[3]!.trim();
  if (tail && !STATE.test(tail)) throw new Error(`this test cannot weigh the selector ${s}`);
  if (tail) holds = false;
  return holds ? spec : null;
}

const gt = (a: number[], b: number[]) => (a[0]! - b[0]!) || (a[1]! - b[1]!) || (a[2]! - b[2]!);

/**
 * `display` as the cascade settles it: the last most-specific author declaration
 * that holds. No match at all is the UA `[hidden]` value when the attribute is
 * there, which any author display rule on the element would have beaten.
 */
function display(el: El, sheet: Rule[]): string | null {
  let win: { spec: [number, number, number]; value: string } | null = null;
  for (const r of sheet) {
    const value = r.decls["display"];
    if (!value) continue;
    for (const part of r.sel.split(",")) {
      const spec = weigh(part, el);
      if (!spec) continue;
      if (!win || gt(spec, win.spec) >= 0) win = { spec, value };
    }
  }
  if (win) return win.value;
  return "hidden" in el.attrs ? "none" : null;
}

const engine = (id: string): EngineReadiness => ({
  id, title: agentProvider(id)!.title, found: true, path: `/usr/bin/${id}`, version: "1.0.0", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: { ok: true }, orchestrator: { ok: true } },
  missing: [], envelope: { via: null, enforced: "yes", note: "" },
});
const READY = [engine("claude"), engine("opencode")];
const base = (): Policy => composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "opus" },
  workers: { scout: { engine: "claude", model: "haiku" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const view = () => renderToStaticMarkup(React.createElement(OrchestrationView, {
  policy: base(), scope: "global", root: "", projects: [], readiness: READY, states: [], seat: null, notes: {}, busy: false,
  onRoot() {}, onSave: async () => null, onScope() {}, onOpenEngines() {},
} as OrchestrationViewProps));

/** The attributes of one tag of the markup, as the browser hands the element to a stylesheet. */
function tagAt(html: string, anchor: string): El {
  const at = html.indexOf(anchor);
  expect(at, anchor).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<", at);
  const end = html.indexOf(">", at);
  const open = html.slice(start + 1, end);
  const attrs: Record<string, string> = {};
  for (const m of open.matchAll(/\s([a-zA-Z-]+)(?:="([^"]*)")?/g)) attrs[m[1]!] = m[2] ?? "";
  return { tag: /^[a-zA-Z][\w-]*/.exec(open)![0].toLowerCase(), classes: (attrs.class ?? "").split(/\s+/).filter(Boolean), attrs };
}

describe("the tabpanels the page renders, against the stylesheet that paints them", () => {
  const sheet = rules(CSS);
  const html = view();
  const ids = ["agx-flow-safety", "agx-flow-refused"];
  const panels = ids.map((id) => ({ id, el: tagAt(html, `id="${id}"`) }));

  test("each tabpanel is a section, and the closed one carries the attribute", () => {
    for (const p of panels) expect(p.el.tag).toBe("section");
    // The first section (Safety and limits) is the one open on arrival; Always refused is closed.
    expect(panels[0]!.el.attrs.hidden).toBeUndefined();
    for (const p of panels.slice(1)) expect(p.el.attrs.hidden).toBeDefined();
  });

  test("a closed tabpanel computes display: none, and only one panel computes visible", () => {
    for (const p of panels.slice(1)) expect(`${p.id}: ${display(p.el, sheet)}`).toBe(`${p.id}: none`);
    // The same element with the attribute on it: the Safety panel closed, which is what the other tab shows.
    const closed = { ...panels[0]!.el, attrs: { ...panels[0]!.el.attrs, hidden: "" } };
    expect(display(closed, sheet)).toBe("none");
    const visible = panels.map((p) => display(p.el, sheet)).filter((d) => d !== "none");
    expect(visible).toHaveLength(1);
  });
});

/** The markup of the element an opening anchor starts, up to its own closing tag, by tag depth. */
function elementAt(html: string, anchor: string): string {
  const at = html.indexOf(anchor);
  expect(at, anchor).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<", at);
  const tag = /^<([a-zA-Z][\w-]*)/.exec(html.slice(start))![1]!;
  const open = new RegExp(`<${tag}(?=[\\s>])|</${tag}>`, "g");
  open.lastIndex = start;
  let depth = 0, m: RegExpExecArray | null;
  while ((m = open.exec(html))) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error(`no close for ${anchor}`);
}

/** One declaration as the sheet settles it for a selector: the last rule that names it exactly. */
function decl(sheet: Rule[], selector: string, prop: string): string | null {
  let out: string | null = null;
  for (const r of sheet) if (r.sel.split(",").some((s) => s.trim() === selector) && r.decls[prop]) out = r.decls[prop]!;
  return out;
}
