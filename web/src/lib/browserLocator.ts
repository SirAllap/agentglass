/**
 * SEMANTIC LOCATORS — the element a person would name, without a look first.
 *
 * Every verb that takes an element takes one of these besides an id from an
 * observation (`e17`) and a CSS selector:
 *
 *   role=button[name="Save"]    the role observe prints (`button`, `a`, `input`)
 *                               or the ARIA one (`link`, `textbox`, `checkbox`,
 *                               `combobox`, `heading`…), and observe's name
 *   label=Email                 a field by its <label>, aria-label or
 *                               aria-labelledby
 *   text=Continue               the innermost element whose text it is
 *   placeholder=Search          a field by its placeholder
 *   testid=submit               data-testid, exactly; hidden ones included
 *
 * Matching is Playwright's: case-insensitive and a substring, and a quoted
 * value is exact (`text="Save"`, `label="Email"`); a role's name is exact with
 * the `s` flag only (`role=button[name="Save" s]`; quoting a role's name does
 * not make it exact). One addition, because the caller here is an agent paying
 * a round trip for every refusal: a node whose whole name is the words beats
 * one whose name only contains them — "Save" next to "Save draft" is not
 * ambiguous to anyone who wrote "Save". The cost is that `text=Save` cannot
 * mean "Save draft" while a plain "Save" is on the page, even a hidden one;
 * say `text=draft` for that.
 *
 * Only what is on screen is found (display, visibility, a box), except by
 * testid, which is a hook a test put there on purpose, and for `upload`,
 * whose file input is usually hidden on purpose. A hidden match is not
 * silently dropped — the refusal names it.
 *
 * The prefixes cannot collide with CSS: `role=…` is not a selector Chromium
 * parses. They are parsed HERE, in TypeScript, and the page receives the
 * parsed shape as data — so the page script has one input, not a string it
 * has to take apart, and a parse error comes back without the page being
 * searched.
 *
 * Ceilings, chosen: no frames and no shadow roots (CSS reaches neither
 * either); role attributes other than `name` (`level`, `checked`, `pressed`)
 * are refused rather than ignored; the name is observe's, not Chromium's
 * accessible name, so a name built from aria-labelledby or an <input
 * type=submit>'s value is not one — `label=` and `text=` reach those — and it
 * is cut at 80 characters, so an exact name longer than that never matches;
 * text= counts an inline script's text as its parent's; and when an input and
 * its button share an aria-label, label= names both and is refused.
 */
import { jsLit } from "../../../shared/jsLit.ts";
import { ACC_NAME, PICK } from "./browserObserve.ts";

export type Locator =
  | { css: string }
  | { by: "role"; role: string; name?: string; exact: boolean }
  | { by: "text" | "label" | "placeholder" | "testid"; value: string; exact: boolean }
  | { invalid: string };

const EXAMPLE: Record<string, string> = {
  role: 'role=button[name="Save"]', text: "text=Continue", label: "label=Email",
  placeholder: "placeholder=Search", testid: "testid=submit",
};

/** A value that may be quoted: `"…"` or `'…'` with backslash escapes, which
 *  must then be all there is; unquoted, it is the rest, trimmed. */
function value(s: string): { value: string; quoted: boolean; rest: string } | { invalid: string } {
  const q = s[0];
  if (q !== '"' && q !== "'") return { value: s.trim(), quoted: false, rest: "" };
  let out = "";
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) { out += s[++i]; continue; }
    if (s[i] === q) return { value: out, quoted: true, rest: s.slice(i + 1) };
    out += s[i];
  }
  return { invalid: `the quote opened at ${q}${s.slice(1, 20)} is never closed` };
}

function role(rest: string): Locator {
  const m = /^([A-Za-z][A-Za-z0-9-]*)\s*(.*)$/s.exec(rest);
  if (!m) return { invalid: `role= needs a role, e.g. ${EXAMPLE.role}` };
  const r = m[1]!.toLowerCase();
  const attr = m[2]!.trim();
  if (!attr) return { by: "role", role: r, exact: false };
  const a = /^\[\s*([A-Za-z-]+)\s*(=?)\s*(.*)$/s.exec(attr);
  if (!a || a[1] !== "name" || !a[2]) {
    return { invalid: `role= takes one [name="…"] and nothing else here (level, checked and the like are not supported), e.g. ${EXAMPLE.role}` };
  }
  const tail = a[3]!;
  if (tail[0] === '"' || tail[0] === "'") {
    const v = value(tail);
    if ("invalid" in v) return v;
    if (!v.value.trim()) return { invalid: `role= has an empty name, e.g. ${EXAMPLE.role}` };
    const f = /^\s*([is])?\s*\]\s*$/.exec(v.rest);
    if (!f) return { invalid: `role= expects ] after the name, e.g. ${EXAMPLE.role}` };
    return { by: "role", role: r, name: v.value, exact: f[1] === "s" };
  }
  const close = tail.indexOf("]");
  if (close === -1 || tail.slice(close + 1).trim()) return { invalid: `role= expects ] after the name, e.g. ${EXAMPLE.role}` };
  const name = tail.slice(0, close).trim();
  if (!name) return { invalid: `role= has an empty name, e.g. ${EXAMPLE.role}` };
  return { by: "role", role: r, name, exact: false };
}

/** A selector as a caller wrote it, as the page will look it up. */
export function parseLocator(raw: string): Locator {
  if (/^e[0-9]+$/.test(raw)) return { css: `[data-agx-e="${raw}"]` };
  const m = /^(role|text|label|placeholder|testid)=/.exec(raw);
  if (!m) return { css: raw };
  const kind = m[1] as "role" | "text" | "label" | "placeholder" | "testid";
  const rest = raw.slice(m[0].length).trim();
  if (kind === "role") return role(rest);
  const v = value(rest);
  if ("invalid" in v) return v;
  if (v.rest.trim()) return { invalid: `${kind}= has something after its closing quote: ${v.rest.trim().slice(0, 20)}` };
  if (!v.value.trim()) return { invalid: `${kind}= needs something to look for, e.g. ${EXAMPLE[kind]}` };
  return { by: kind, value: v.value, exact: kind === "testid" || v.quoted };
}

/** The parsed selector as a JavaScript literal, ready for a page script. */
export const locatorLit = (raw: string): string => jsLit(parseLocator(raw));

/**
 * The page half: a parsed locator in, `{kind: "found", all, hidden, near}` or
 * `{kind: "invalid", message}` out. `all` is what matched and is on screen,
 * `hidden` what matched and is not, `near` up to five on-screen nodes of the
 * same kind that did not match (`{n, t}`: the node and the text it goes by) so
 * a refusal can say what IS there. How many is too many is the caller's call.
 *
 * No less-than sign anywhere in here: a verb's generated code is checked for
 * one as a sign a selector escaped its literal (browser-drive.test.ts).
 */
export const FIND = `((spec) => {
  if (spec.invalid) return { kind: "invalid", message: spec.invalid };
  if (spec.css !== undefined) {
    let all;
    try { all = document.querySelectorAll(spec.css); }
    catch (err) { return { kind: "invalid", message: String((err && err.message) || err) }; }
    return { kind: "found", all: [...all], hidden: [], near: [] };
  }
  const norm = (s) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim();
  const name = ${ACC_NAME};
  const onScreen = (n) => {
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(n);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };
  /* For text=: a one-pixel box is a screen-reader-only label, there to be
     read and not clicked, so it counts as hidden and the visible element
     around it is the match. Measured: text= on an icon button landed on its
     sr-only span, and the click was refused as covered. */
  const big = (n) => { const r = n.getBoundingClientRect(); return r.width > 1 && r.height > 1 && onScreen(n); };
  const seen = spec.by === "text" ? big : onScreen;
  const want = norm(spec.by === "role" ? spec.name : spec.value);
  const lower = want.toLowerCase();
  const fits = (t) => spec.exact ? norm(t) === want : norm(t).toLowerCase().includes(lower);
  const whole = (t) => norm(t).toLowerCase() === lower;
  let pool, texts;
  if (spec.by === "role") {
    const implicit = (n) => {
      const t = n.tagName.toLowerCase();
      if (t === "a") return n.hasAttribute("href") ? "link" : "";
      if (t === "button") return "button";
      if (t === "select") return n.multiple || n.size > 1 ? "listbox" : "combobox";
      if (t === "textarea") return "textbox";
      if (/^h[1-6]$/.test(t)) return "heading";
      const landmark = { dialog: "dialog", img: "img", nav: "navigation", main: "main", li: "listitem",
        ul: "list", ol: "list", table: "table", article: "article", form: "form", aside: "complementary" }[t];
      if (landmark) return landmark;
      if (t !== "input") return "";
      return ({ button: "button", submit: "button", reset: "button", image: "button",
        checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox",
        text: "textbox", email: "textbox", tel: "textbox", url: "textbox", password: "textbox",
      })[(n.type || "text").toLowerCase()] || "";
    };
    const roles = (n) => {
      const own = norm(n.getAttribute("role")).split(" ")[0];
      return own ? [own] : [n.tagName.toLowerCase(), implicit(n)];
    };
    pool = [...document.querySelectorAll(${jsLit(PICK + ",h4,h5,h6,dialog,img,nav,main,li,ul,ol,table,article,form,aside")})]
      .filter((n) => roles(n).includes(spec.role));
    texts = spec.name === undefined ? null : (n) => [name(n) || n.getAttribute("alt") || ""];
  } else if (spec.by === "label") {
    pool = [...document.querySelectorAll("input,select,textarea,[aria-label],[aria-labelledby]")];
    texts = (n) => [
      /* A label that wraps its control also reads the control's own text —
         a wrapped select's label says "Plan Team Solo" — so that is taken out. */
      ...[...(n.labels || [])].map((l) => {
        const lt = l.innerText || l.textContent || "";
        const ct = l.contains(n) ? (n.innerText || n.textContent || "") : "";
        return ct ? lt.replace(ct, "") : lt;
      }),
      n.getAttribute("aria-label"),
      ...norm(n.getAttribute("aria-labelledby")).split(" ").filter(Boolean)
        .map((id) => { const t = document.getElementById(id); return t ? t.textContent : ""; }),
    ].filter((t) => norm(t));
  } else if (spec.by === "placeholder") {
    pool = [...document.querySelectorAll("[placeholder]")];
    texts = (n) => [n.getAttribute("placeholder")];
  } else if (spec.by === "testid") {
    pool = [...document.querySelectorAll("[data-testid]")];
    texts = (n) => [n.getAttribute("data-testid")];
  } else {
    const skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    /* Pruned, not every element: a node's text holds all its descendants'
       text, so a subtree whose text lacks the words holds no match. Reading
       every element's text was measured at ~600 ms on a 68k-element page,
       and wait repeats a lookup every 120 ms. */
    const hits = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (skip[String(c.tagName).toUpperCase()]) continue;
        const t = c.textContent;
        if (!norm(t).toLowerCase().includes(lower)) continue;
        if (fits(t)) hits.push(c);
        walk(c);
      }
    };
    walk(document.body || document.documentElement);
    /* The innermost ON SCREEN, so a hidden or one-pixel child (a tooltip, a
       screen-reader-only label) does not take the place of the visible thing
       around it. In document order a node's descendants come straight after
       it, so a hit followed by one it contains is an ancestor of it; that
       holds for any subsequence too. */
    const innermost = (list) => list.filter((n, i) => !(list[i + 1] && n.contains(list[i + 1])));
    pool = [...innermost(hits.filter(big)), ...innermost(hits.filter((n) => !big(n)))]
      .concat([...document.querySelectorAll('input[type="button"],input[type="submit"],input[type="reset"]')]
        .filter((n) => fits(n.value)));
    texts = (n) => [n.tagName === "INPUT" ? n.value : n.textContent];
  }
  let matched = texts ? pool.filter((n) => texts(n).some(fits)) : pool;
  /* The whole name before a part of one, whether or not it is on screen: a
     hidden "Save" beside a visible "Save draft" is refused as hidden rather
     than answered with the draft button. */
  if (!spec.exact && texts) {
    const exactly = matched.filter((n) => texts(n).some(whole));
    if (exactly.length) matched = exactly;
  }
  const everywhere = spec.by === "testid" || spec.hidden === true;
  const all = everywhere ? matched : matched.filter(seen);
  const hidden = everywhere ? [] : matched.filter((n) => !seen(n));
  const near = all.length || hidden.length || spec.by === "text" ? [] : pool
    .filter((n) => everywhere || onScreen(n))
    .map((n) => ({ n, t: norm(texts ? texts(n)[0] : name(n)).slice(0, 40) }))
    .filter((x) => x.t)
    .slice(0, 5);
  return { kind: "found", all, hidden, near };
})`;
