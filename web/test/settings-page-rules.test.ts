/*
 * The settings pages' layout rules, held against the source of EVERY page.
 *
 * Measured with the settings sweep (a headless walk of every page counting
 * each defect class), the defects were not one page's: doubled hairlines and
 * a rule beside every heading came from the old box's `* + *` borders,
 * clipped descriptions and More/Less from a twelve-word fold, several inputs
 * squeezed onto one line from a hand-built form, and hand-rolled `py-1`
 * buttons in rows of their own from pages that never used `Button`. Each was
 * patched on one page and came back on the next.
 *
 * So the rules are read here, page by page, from what each page renders: the
 * `{show("id") && …}` block in SettingsModal plus the body of every component
 * that block names, three levels down (pane, card, row). A page
 * added to TABS is covered without anyone listing it.
 *
 * Two kinds of check:
 *   - hard rules, for the CSS and the shared blocks, which nothing may break;
 *   - a ratchet per page (settings-ratchet.txt), for the pages still on the
 *     old box. A count may only go down, and when it does the ceiling must
 *     go down with it, so the room a migration frees cannot be refilled. The
 *     migrated pages are held at zero outright.
 *
 * The ceiling, said plainly: this reads source, not pixels. A defect drawn by
 * a component more than one level below a page's block, or built from a
 * computed class string, is not seen here; the sweep (see docs/design-system.md,
 * "Settings pages") is what measures the rendered page.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const COMPONENTS = join(SRC, "components");
const read = (p: string) => readFileSync(p, "utf8");
const strip = (s: string) => s
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const css = read(join(SRC, "index.css")).replace(/\/\*[\s\S]*?\*\//g, "");
const modal = read(join(COMPONENTS, "SettingsModal.tsx"));
const kit = strip(read(join(COMPONENTS, "SettingsKit.tsx")));
const rowSrc = strip(read(join(COMPONENTS, "SettingRow.tsx")));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const FILES = walk(COMPONENTS).map((p) => ({ p, text: read(p) }));

/** A top-level function's body in one file, from its signature to the next top-level function. */
function bodyIn(text: string, name: string): string {
  const at = text.search(new RegExp(`(^|\\n)(?:export )?function ${name}(?:<[^(]*>)?\\(`));
  if (at < 0) return "";
  const from = text.indexOf("function", at);
  const next = text.slice(from + 8).search(/\n(?:export )?function \w+[<(]/);
  return next < 0 ? text.slice(from) : text.slice(from, from + 8 + next);
}

/** Where `name` used from `file` is defined: the file itself, or the
 *  component file it imports the name from. Never a namesake elsewhere — a
 *  local `Item` in one file is not the `Item` of another. */
function resolve(name: string, file: string): { file: string; body: string } | null {
  const text = FILES.find((f) => f.p === file)?.text ?? "";
  const here = bodyIn(text, name);
  if (here) return { file, body: here };
  for (const m of text.matchAll(/import \{([^}]*)\} from "(\.[^"]+\.tsx)"/g)) {
    if (!m[1]!.split(",").map((x) => x.trim().replace(/^type /, "")).includes(name)) continue;
    const target = join(file, "..", m[2]!);
    const t = FILES.find((f) => f.p === target)?.text;
    const body = t ? bodyIn(t, name) : "";
    if (body) return { file: target, body };
  }
  return null;
}

/** The shared blocks are measured once, by the hard rules, not per page. */
const SHARED = new Set(["SettingRow", "Toggle", "Fold", "Switch", "Section", "SettingsCard", "StatusBadge",
  "Disclosure", "SettingsForm", "Field", "EmptyState", "LinkButton", "Button", "Segmented", "Select", "Fragment"]);

const tabIds = [...modal.matchAll(/\{ id: "([a-z-]+)", label: "([^"]*)", group: "/g)].map((m) => ({ id: m[1]!, label: m[2]! }));

/** Each page's own source: its show blocks and the components they name,
 *  three levels down (the pane, its cards, their rows). */
function pageSource(id: string): string {
  const marks = [...modal.matchAll(/\{show\("([a-z-]+)"\) &&/g)];
  let text = "";
  for (let i = 0; i < marks.length; i++) {
    if (marks[i]![1] !== id) continue;
    const from = marks[i]!.index!;
    // A block ends where the next page's block starts.
    const to = marks.slice(i + 1).find((m) => m[1] !== id)?.index ?? modal.length;
    text += modal.slice(from, to);
  }
  const MODAL = join(COMPONENTS, "SettingsModal.tsx");
  const seen = new Set<string>();
  let out = text;
  let layer: { file: string; text: string }[] = [{ file: MODAL, text }];
  for (let depth = 0; depth < 3; depth++) {
    const next: { file: string; text: string }[] = [];
    for (const l of layer) {
      for (const m of l.text.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)) {
        const name = m[1]!;
        if (SHARED.has(name)) continue;
        const r = resolve(name, l.file);
        if (!r || seen.has(`${r.file}:${name}`)) continue;
        seen.add(`${r.file}:${name}`);
        next.push({ file: r.file, text: r.body });
        out += "\n" + r.body;
      }
    }
    layer = next;
  }
  return strip(out);
}

/** The prop expressions `control={…}` in a source, brace-balanced. */
function controlProps(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bcontrol=\{/g)) {
    let depth = 0, i = m.index! + "control=".length;
    const from = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    out.push(src.slice(from, i + 1));
  }
  return out;
}

/** The defect classes, as source patterns. */
const METRICS: Record<string, (src: string) => number> = {
  /** The old box, whose `* + *` borders drew the doubled lines. */
  "old-box": (s) => (s.match(/agx-settings-section|agx-settings-rows|<Section\b/g) ?? []).length,
  /** An eyebrow used as a heading inside a card. */
  "eyebrow": (s) => (s.match(/panel-eyebrow/g) ?? []).length,
  /** Text cut with an ellipsis. A machine string (a path, a command, a binary
   *  name: `<code>`, `t-mono`) may truncate when it carries its whole value in
   *  a `title`; prose may not. */
  "clipped": (s) => (s.match(/<[a-z]+\b[^>]*\b(line-clamp|truncate|text-ellipsis)\b[^>]*>/g) ?? [])
    .filter((tag) => !(/^<code\b|t-mono/.test(tag) && /\btitle=|t-mono/.test(tag))).length,
  /** A More / Less toggle, or a disclosure that does not say what it holds. */
  "vague-more": (s) => (s.match(/>\s*(More|Less|About this one|Details|Show more)\s*</g) ?? []).length
    + (s.match(/summary="(More|Less|About this one|Details|Show more|Info)"/g) ?? []).length,
  /** A text field squeezed into the control column, or two inputs on one line. */
  "inline-input": (s) => controlProps(s).filter((c) => /<input(?![^>]*type="(checkbox|radio)")/.test(c)).length
    + (s.match(/flex-1 min-w-\[\d+px\] \$\{INPUT\}/g) ?? []).length,
  /** A hand-rolled small button: `py-1`/`py-0.5`/`py-1.5` on a `<button` or a link drawn as one. */
  "hand-button": (s) => (s.match(/<(button|a)\b[^>]*className="[^"]*\bpy-(0\.5|1|1\.5)\b[^"]*"/g) ?? []).length,
  /** A semantic hue used as text without its ink. */
  "bare-tint": (s) => (s.match(/(fg|color): "var\(--(warning|error|success)\)"/g) ?? []).length,
};

/** Held at zero: the pages already built from the kit. */
const MIGRATED = ["connections", "clickup", "jira", "prefs", "appearance", "notifications", "rail", "keys", "terminal", "diff", "tasks", "browser", "lantern", "understudy", "review-prompts", "saved-replies", "about", "privacy", "tmux", "plugins", "remote", "log", "onboarding"];

const RATCHET_PATH = join(import.meta.dir, "settings-ratchet.txt");
const ceilings = new Map<string, number>();
for (const line of read(RATCHET_PATH).split("\n")) {
  const m = line.match(/^([a-z-]+)\s+([a-z-]+)\s+(\d+)\s*$/);
  if (m) ceilings.set(`${m[1]} ${m[2]}`, Number(m[3]));
}

describe("every settings page", () => {
  test("is found: TABS has pages and each has a rendered block", () => {
    expect(tabIds.length).toBeGreaterThan(20);
    const missing = tabIds.filter((t) => !new RegExp(`\\{show\\("${t.id}"\\) &&`).test(modal)).map((t) => t.id);
    // A tab with no block of its own is reached through another page (an
    // alias). Named here so a new one is a decision, not an accident.
    expect(missing.sort()).toEqual([]);
  });

  test("migrated pages carry none of the defect classes", () => {
    const bad: string[] = [];
    for (const id of MIGRATED) {
      const src = pageSource(id);
      expect(src.length, id).toBeGreaterThan(500);
      for (const [k, f] of Object.entries(METRICS)) { const n = f(src); if (n) bad.push(`${id} ${k} ${n}`); }
    }
    expect(bad).toEqual([]);
  });

  test("the others never get worse, and their ceiling follows them down", () => {
    const over: string[] = [];
    const under: string[] = [];
    const actual: string[] = [];
    for (const { id } of tabIds) {
      if (MIGRATED.includes(id)) continue;
      const src = pageSource(id);
      for (const [k, f] of Object.entries(METRICS)) {
        const n = f(src);
        const c = ceilings.get(`${id} ${k}`) ?? 0;
        if (n) actual.push(`${id} ${k} ${n}`);
        if (n > c) over.push(`${id} ${k}: ${n} > ${c}`);
        if (n < c) under.push(`${id} ${k}: ${n} < ${c}`);
      }
    }
    expect(over, "a page reintroduced a defect the kit removes; build it from SettingsKit").toEqual([]);
    expect(under, `lower these in web/test/settings-ratchet.txt. Current counts:\n${actual.join("\n")}`).toEqual([]);
  });
});

describe("the one divider", () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
  test("no border in a kit selector except the row divider", () => {
    const kitRules = rules.filter((r) => /agx-scard|agx-slot|agx-row-below|agx-disclosure|agx-sform|agx-field/.test(r.sel));
    expect(kitRules.length).toBeGreaterThan(5);
    const bordered = kitRules.filter((r) => /border(-top|-bottom|-left|-right)?\s*:/.test(r.body)).map((r) => r.sel);
    expect(bordered).toEqual([
      ".agx-settings-col .agx-scard",
      ".agx-scard-body > .agx-settings-row + .agx-settings-row::before,\n.agx-scard-body > .agx-fold-body + .agx-settings-row::before",
    ]);
  });
  test("no new sibling-of-anything border rule", () => {
    // The two old ones stay until the last page leaves the old box.
    expect((css.match(/\* \+ \* \{/g) ?? []).length).toBe(2);
  });
  test("neither a card heading nor a page title draws a line", () => {
    for (const r of rules.filter((x) => /^\.agx-settings-head\b|> \.panel-eyebrow$|^\.agx-scard-head/.test(x.sel))) {
      expect(r.body, r.sel).not.toMatch(/border/);
    }
    expect(css).not.toContain(".agx-settings-head + .agx-settings-rows");
    const title = modal.indexOf("{t.label}</h2>");
    expect(title).toBeGreaterThan(-1);
    expect(modal.slice(modal.lastIndexOf("<div", modal.lastIndexOf("<div", title) - 1), title)).not.toMatch(/border-b/);
  });
});

describe("the shared blocks", () => {
  test("a description is never clipped and never folded behind More", () => {
    expect(rowSrc).not.toMatch(/line-clamp|truncate|HINT_FOLD|More|Less/);
    expect(kit).not.toMatch(/line-clamp|\btruncate\b/);
  });
  test("every disclosure in the settings files says what it holds", () => {
    const vague = /^(more|less|details|info|about this one|show more|show)$/i;
    const bad: string[] = [];
    for (const f of FILES) {
      for (const m of f.text.matchAll(/<Disclosure summary="([^"]*)"/g)) if (vague.test(m[1]!) || m[1]!.length < 8) bad.push(`${f.p}: ${m[1]}`);
      for (const m of f.text.matchAll(/noteTitle: "([^"]*)"/g)) if (vague.test(m[1]!)) bad.push(`${f.p}: ${m[1]}`);
    }
    const providers = read(join(SRC, "..", "..", "shared", "providers.ts"));
    for (const m of providers.matchAll(/noteTitle: "([^"]*)"/g)) if (vague.test(m[1]!) || m[1]!.length < 8) bad.push(`providers: ${m[1]}`);
    // Every provider with a note names it.
    expect((providers.match(/\n\s+note: "/g) ?? []).length).toBe((providers.match(/\n\s+noteTitle: "/g) ?? []).length);
    expect(bad).toEqual([]);
  });
  test("status badges use ink, and the badge comes first in the control column", () => {
    expect(kit).toContain('ok: "var(--success-ink)", warn: "var(--warning-ink)", err: "var(--error-ink)"');
    const row = rowSrc.slice(rowSrc.indexOf("export function SettingRow("));
    expect(row).toContain('<span className="agx-slot">{status}{control}{actions}</span>');
    expect(kit).toContain('<div className="agx-slot">{status}{actions}</div>');
  });
  test("a form stacks: label above the field, help under it, 480px at most", () => {
    expect(css).toMatch(/\.agx-sform \{ display: flex; flex-direction: column; gap: 12px; max-width: 480px; \}/);
    expect(css).toMatch(/\.agx-field \{ display: flex; flex-direction: column; gap: 6px; \}/);
    const field = kit.slice(kit.indexOf("export function Field("));
    expect(field.indexOf("<label")).toBeLessThan(field.indexOf("{children}"));
    expect(field.indexOf("{children}")).toBeLessThan(field.indexOf("agx-field-h"));
  });
  test("a switch's wrapper has no line box, so a toggle has the same padding above and below", () => {
    // An inline-block on a text baseline leaves the descender gap under it: the
    // sweep measured 14px above a toggle and 21px below once it dropped under
    // the words at 640px.
    expect(rowSrc).toMatch(/role === "switch" \? " flex" : ""/);
  });
  test("what stacks under a row spans both columns", () => {
    expect(css).toMatch(/\.agx-settings-row > div\.agx-row-below \{\s*grid-column: 1 \/ -1;/);
  });
});

describe("the Jira card", () => {
  const providers = read(join(SRC, "..", "..", "shared", "providers.ts"));
  const jira = providers.slice(providers.indexOf('id: "jira"'), providers.indexOf("},", providers.indexOf('id: "jira"')));
  test("says what it does now: it reads cards, from Cloud or Data Center", () => {
    expect(jira).not.toMatch(/no cards are read|as far as it goes/);
    expect(jira).toMatch(/what: "[^"]*cards[^"]*Jira Cloud[^"]*Data Center/);
  });
  test("one form, on Jira's own page: the kind first, then site, account and token, then one Connect", () => {
    const page = strip(read(join(COMPONENTS, "JiraPane.tsx")));
    const card = page.slice(page.indexOf("function ConnectCard("), page.indexOf("const Tag = "));
    const order = ['label="Jira type"', 'label="Site"', 'label={cloud ? "Email"', "type=\"password\"", ">Connect</Button>"].map((s) => card.indexOf(s));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect((card.match(/>Connect<\/Button>/g) ?? []).length).toBe(1);
    expect(card).toContain("<SettingsForm");
  });
  test("Tools & services keeps a verdict and a way in for Jira, and no form", () => {
    const card = strip(modal.slice(modal.indexOf("function ProviderCard("), modal.indexOf("\nfunction RequirementsPane(")));
    expect(card).not.toMatch(/jiraConnect|jiraKind|Jira type/);
    expect(card).toContain('openSettings("jira")');
  });

});
