/**
 * What a plugin may draw, as data.
 *
 * A plugin never ships code into the window. The window holds the API token
 * and can open a shell (docs/PLUGINS.md, "What a plugin cannot do"), so a
 * plugin's own script there would inherit both. Instead a plugin describes a
 * screen as a tree of the nodes below, POSTs it, and the app draws it with its
 * own components: the same buttons, rows and markdown every built-in view
 * uses. A plugin can look like part of the app without being able to act as
 * the app.
 *
 * Every tree is checked here before it is stored, on both sides of the wire:
 * the server refuses what does not fit, and the web client, which receives
 * only what the server kept, still renders an unknown node as nothing rather
 * than trusting the shape. Limits are generous for a real screen (a review
 * with a few hundred findings) and small enough that a runaway plugin cannot
 * make the window allocate its way to a freeze.
 *
 * Deliberately absent: raw HTML, inline styles, colours, images by URL and
 * anything that runs. A tone is a word the app maps to its own palette, so a
 * plugin follows the theme, light or dark, without knowing there is one. A
 * sandboxed frame for the screens this vocabulary cannot express is the next
 * thing after this and is not here. A panel that has to move (a board where
 * things travel between stages) is the other vocabulary, pluginCanvas.ts.
 */

export type Tone = "default" | "muted" | "accent" | "success" | "warning" | "danger";
export const TONES: readonly Tone[] = ["default", "muted", "accent", "success", "warning", "danger"];

/** A click, sent back to the plugin that drew it. `payload` is the plugin's
 *  own data, echoed untouched; the app never reads it. */
export interface UiAction { id: string; payload?: unknown }

export interface UiBadge { text: string; tone?: Tone }

/**
 * "Take me to that pull request" — the app opens it and the plugin is not
 * told, because there is nothing for it to do.
 *
 * A row about a pull request that cannot be clicked into is a dead end: a
 * reviewer plugin listed six of them and the only way to reach one was to
 * remember which project it lived in and go there by hand. `action` cannot
 * serve this — it is a message to the plugin, and what has to happen is the
 * app's. The pull request is opened wherever it lives, whatever project is
 * open (see `/prs/locate`), and `focus` says which lane to land on.
 */
export interface UiOpenPr { repo: string; number: number; focus?: "local" }

export interface UiListItem {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
  badges?: UiBadge[];
  action?: UiAction;
  open?: UiOpenPr;
  selected?: boolean;
}

export interface UiTimelineItem {
  id: string;
  /** Epoch milliseconds; drawn as a relative time. */
  at?: number;
  title: string;
  body?: string;
  tone?: Tone;
  badges?: UiBadge[];
  action?: UiAction;
  open?: UiOpenPr;
}

export type FieldType = "string" | "text" | "number" | "boolean" | "select" | "list" | "multi" | "secret";

export interface FieldOption { value: string; label: string }

/**
 * One input, in a plugin's settings page or in a form it draws. The same
 * shape serves both so a plugin author learns one vocabulary. `list` is a list
 * of short strings typed one per row; `multi` is several picked from
 * `options` — which a plugin can fill at run time, like the repositories the
 * person can reach — with a search when there are many. `secret` is a token or
 * a key: typed into a masked box, kept in the same 0600 file as the rest, and
 * read back only by the plugin that declared it (see `redactSecrets`). The
 * ceiling: that file is readable by a plugin that runs outside its box and by
 * any program running as the same user; this hides the value from the app's
 * screens and its API, not from the disk.
 */
export interface Field {
  key: string;
  type: FieldType;
  label: string;
  /** Which heading this field sits under on the settings page. Fields with
   *  no group come first, under no heading; the rest keep the order they were
   *  declared in. Thirteen fields in one column is a wall nobody wants to
   *  configure, and only the plugin knows which of them belong together. A
   *  group called "Advanced" starts folded. */
  group?: string;
  description?: string;
  placeholder?: string;
  default?: unknown;
  options?: FieldOption[];
  min?: number;
  max?: number;
}

export type UiNode =
  | { type: "stack"; gap?: "sm" | "md" | "lg"; children: UiNode[] }
  | { type: "row"; gap?: "sm" | "md" | "lg"; align?: "start" | "center" | "between"; wrap?: boolean; children: UiNode[] }
  | { type: "section"; title: string; subtitle?: string; actions?: UiNode[]; children: UiNode[] }
  | { type: "split"; left: UiNode[]; right: UiNode[]; leftWidth?: "narrow" | "half" }
  | { type: "tabs"; selected?: string; tabs: { id: string; label: string; badge?: string; children: UiNode[] }[] }
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "text"; text: string; tone?: Tone; size?: "sm" | "md"; mono?: boolean }
  | { type: "markdown"; text: string }
  | { type: "code"; text: string; lang?: string }
  | { type: "badge"; text: string; tone?: Tone }
  | { type: "stat"; label: string; value: string; tone?: Tone; hint?: string }
  | { type: "keyValue"; items: { label: string; value: string; tone?: Tone }[] }
  | { type: "list"; items: UiListItem[]; empty?: string }
  | { type: "timeline"; items: UiTimelineItem[]; empty?: string }
  | { type: "button"; label: string; action: UiAction; tone?: "primary" | "default" | "danger"; confirm?: string; disabled?: boolean }
  | { type: "form"; id: string; fields: Field[]; values?: Record<string, unknown>; submit: { label: string; action: UiAction } }
  | { type: "progress"; value?: number; label?: string }
  | { type: "empty"; title: string; body?: string; action?: UiNode }
  | { type: "link"; text: string; href: string }
  | { type: "divider" };

export const UI_LIMITS = {
  nodes: 4000,
  depth: 16,
  /** Per string. Markdown and code get the long budget: a review's finding
   *  quotes code, and a summary is a page of prose. */
  short: 400,
  long: 40_000,
  items: 1000,
  payloadBytes: 8_192,
  fields: 60,
  options: 200,
  /** The whole tree, serialised. Per-node limits alone let 4000 nodes of
   *  40,000 characters through — 160 MB for every open window to download
   *  on each redraw. A real screen is well under this. */
  treeBytes: 1_000_000,
} as const;

/** Epoch milliseconds a Date can hold. A plugin's `1e16` would otherwise be
 *  stored and make `toISOString()` throw on every render of the pull request
 *  it was written on, for good. */
const MAX_MS = 8.64e15;
export function validMs(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_MS ? v : undefined;
}

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

class Walk {
  nodes = 0;
  constructor(public error: string | null = null) {}
  fail(msg: string): null { if (!this.error) this.error = msg; return null; }
}

function str(v: unknown, max: number, w: Walk, what: string, optional = false): string | undefined | null {
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string") return w.fail(`${what} must be a string`);
  if (v.length > max) return w.fail(`${what} is longer than ${max} characters`);
  return v;
}

function tone(v: unknown): Tone | undefined {
  return typeof v === "string" && (TONES as readonly string[]).includes(v) ? (v as Tone) : undefined;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

function action(v: unknown, w: Walk, what: string): UiAction | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return w.fail(`${what} must be an object with an id`);
  const a = v as Record<string, unknown>;
  const id = str(a.id, 120, w, `${what}.id`);
  if (id === null || id === undefined) return null;
  if (a.payload === undefined) return { id };
  let bytes: number;
  try { bytes = JSON.stringify(a.payload).length; } catch { return w.fail(`${what}.payload is not JSON`); }
  if (bytes > UI_LIMITS.payloadBytes) return w.fail(`${what}.payload is over ${UI_LIMITS.payloadBytes} bytes`);
  return { id, payload: JSON.parse(JSON.stringify(a.payload)) };
}

/** Where a row points. Rejected rather than dropped: a row that says it opens
 *  a pull request and silently does not is worse than a tree that refused. */
function openPr(v: unknown, w: Walk, what: string): UiOpenPr | null | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) return w.fail(`${what} must be an object with repo and number`);
  const o = v as Record<string, unknown>;
  const ref = validPrRef(o.repo, o.number);
  if (!ref) return w.fail(`${what} needs repo as owner/name and a pull request number`);
  const focus = oneOf(o.focus, ["local"] as const);
  return focus ? { ...ref, focus } : ref;
}

function badges(v: unknown, w: Walk): UiBadge[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: UiBadge[] = [];
  for (const b of v.slice(0, 12)) {
    if (!b || typeof b !== "object") continue;
    const text = str((b as Record<string, unknown>).text, 60, w, "badge text");
    if (typeof text === "string") out.push({ text, tone: tone((b as Record<string, unknown>).tone) });
  }
  return out;
}

/** Only https, and nothing a click could turn into a script. The web side
 *  opens it through the same external-link path every other link uses. */
export function safeHref(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2000) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Names that are properties of every object. A plugin name and a field key end
 *  up as keys of plain objects (the store, a plugin's settings, the secrets);
 *  `__proto__` among them is the object's prototype, not an entry, so a write
 *  under it lands on Object.prototype and is read back by every object. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function validateField(raw: unknown, w: Walk): Field | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return w.fail("a field must be an object");
  const f = raw as Record<string, unknown>;
  const key = str(f.key, 60, w, "field.key");
  if (typeof key !== "string") return null;
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)) return w.fail(`field key "${key}" must start with a letter and hold only letters, digits, . _ -`);
  if (RESERVED_KEYS.has(key)) return w.fail(`field key "${key}" is a property every object has, so it cannot name a setting`);
  const type = oneOf(f.type, ["string", "text", "number", "boolean", "select", "list", "multi", "secret"] as const);
  if (!type) return w.fail(`field "${key}" has an unknown type`);
  const label = str(f.label, 120, w, `field "${key}" label`);
  if (typeof label !== "string") return null;
  const out: Field = { key, type, label };
  const description = str(f.description, UI_LIMITS.short, w, `field "${key}" description`, true);
  if (description === null) return null;
  if (description) out.description = description;
  const placeholder = str(f.placeholder, 120, w, `field "${key}" placeholder`, true);
  if (placeholder === null) return null;
  if (placeholder) out.placeholder = placeholder;
  const group = str(f.group, 60, w, `field "${key}" group`, true);
  if (group === null) return null;
  if (group) out.group = group;
  if (Array.isArray(f.options)) {
    out.options = [];
    for (const o of f.options.slice(0, UI_LIMITS.options)) {
      if (typeof o === "string" && o.length <= 120) out.options.push({ value: o, label: o });
      else if (o && typeof o === "object") {
        const r = o as Record<string, unknown>;
        if (typeof r.value === "string" && r.value.length <= 200) {
          out.options.push({ value: r.value, label: typeof r.label === "string" ? r.label.slice(0, 120) : r.value });
        }
      }
    }
  }
  if (typeof f.min === "number" && Number.isFinite(f.min)) out.min = f.min;
  if (typeof f.max === "number" && Number.isFinite(f.max)) out.max = f.max;
  // A default is written in the manifest, and a manifest is a public file: a
  // key that ships in one is not a secret any more.
  if (type === "secret" && f.default !== undefined) return w.fail(`field "${key}" is a secret and cannot have a default`);
  if (f.default !== undefined) {
    const d = coerceValue(out, f.default);
    if (d !== undefined) out.default = d;
  }
  return out;
}

/**
 * A value made to fit its field, or `undefined` when it cannot be. Settings
 * are typed by the manifest, not by whatever the form or the plugin sent, so
 * a plugin reading `repos` always gets a list of strings.
 */
export function coerceValue(f: Field, v: unknown): unknown {
  switch (f.type) {
    case "string":
    case "text": {
      if (typeof v !== "string") return undefined;
      return v.slice(0, f.type === "text" ? UI_LIMITS.long : UI_LIMITS.short);
    }
    case "number": {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
      if (!Number.isFinite(n)) return undefined;
      return Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n));
    }
    case "boolean":
      return typeof v === "boolean" ? v : undefined;
    case "secret": {
      // One line, no padding: a key pasted with its newline is a key the
      // service rejects, and nothing about it is worth a second look.
      if (typeof v !== "string") return undefined;
      return v.trim().slice(0, SECRET_MAX);
    }
    case "select": {
      if (typeof v !== "string") return undefined;
      // Options can arrive after the value (a plugin publishes them once it
      // has looked around), so an unknown value is kept rather than dropped.
      return v.slice(0, 200);
    }
    case "list":
    case "multi": {
      const items = Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : null;
      if (!items) return undefined;
      return items
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, f.type === "multi" ? 500 : 200)
        .map((x) => x.slice(0, 300));
    }
  }
}

/** Longest secret kept. Real keys and tokens are well under 200. */
export const SECRET_MAX = 512;

export function validateFields(raw: unknown): Ok<Field[]> | Err {
  if (!Array.isArray(raw)) return { ok: false, error: "fields must be a list" };
  if (raw.length > UI_LIMITS.fields) return { ok: false, error: `at most ${UI_LIMITS.fields} fields` };
  const w = new Walk();
  const out: Field[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    const v = validateField(f, w);
    if (!v) return { ok: false, error: w.error ?? "bad field" };
    if (seen.has(v.key)) return { ok: false, error: `field key "${v.key}" appears twice` };
    seen.add(v.key);
    out.push(v);
  }
  return { ok: true, value: out };
}

function children(v: unknown, w: Walk, depth: number, what: string): UiNode[] | null {
  if (!Array.isArray(v)) return w.fail(`${what} must be a list`);
  const out: UiNode[] = [];
  for (const c of v) {
    const n = node(c, w, depth + 1);
    if (!n) return null;
    out.push(n);
  }
  return out;
}

function node(raw: unknown, w: Walk, depth: number): UiNode | null {
  if (w.error) return null;
  if (++w.nodes > UI_LIMITS.nodes) return w.fail(`more than ${UI_LIMITS.nodes} nodes`);
  if (depth > UI_LIMITS.depth) return w.fail(`nested deeper than ${UI_LIMITS.depth}`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return w.fail("a node must be an object");
  const n = raw as Record<string, unknown>;
  const S = UI_LIMITS.short;
  const gap = oneOf(n.gap, ["sm", "md", "lg"] as const);
  switch (n.type) {
    case "stack": {
      const c = children(n.children, w, depth, "stack.children");
      return c && { type: "stack", gap, children: c };
    }
    case "row": {
      const c = children(n.children, w, depth, "row.children");
      return c && { type: "row", gap, align: oneOf(n.align, ["start", "center", "between"] as const), wrap: n.wrap === true, children: c };
    }
    case "section": {
      const title = str(n.title, S, w, "section.title");
      const subtitle = str(n.subtitle, S, w, "section.subtitle", true);
      const c = children(n.children, w, depth, "section.children");
      const actions = n.actions === undefined ? [] : children(n.actions, w, depth, "section.actions");
      if (typeof title !== "string" || subtitle === null || !c || !actions) return null;
      return { type: "section", title, subtitle, actions, children: c };
    }
    case "split": {
      const left = children(n.left, w, depth, "split.left");
      const right = children(n.right, w, depth, "split.right");
      return left && right && { type: "split", left, right, leftWidth: oneOf(n.leftWidth, ["narrow", "half"] as const) };
    }
    case "tabs": {
      if (!Array.isArray(n.tabs)) return w.fail("tabs.tabs must be a list");
      const tabs: { id: string; label: string; badge?: string; children: UiNode[] }[] = [];
      for (const t of n.tabs.slice(0, 20)) {
        if (!t || typeof t !== "object") return w.fail("a tab must be an object");
        const r = t as Record<string, unknown>;
        const id = str(r.id, 120, w, "tab.id");
        const label = str(r.label, 80, w, "tab.label");
        const badge = str(r.badge, 20, w, "tab.badge", true);
        const c = children(r.children, w, depth, "tab.children");
        if (typeof id !== "string" || typeof label !== "string" || badge === null || !c) return null;
        tabs.push({ id, label, badge, children: c });
      }
      const selected = typeof n.selected === "string" ? n.selected.slice(0, 120) : undefined;
      return { type: "tabs", selected, tabs };
    }
    case "heading": {
      const text = str(n.text, S, w, "heading.text");
      const level = n.level === 1 || n.level === 2 || n.level === 3 ? n.level : undefined;
      return typeof text === "string" ? { type: "heading", text, level } : null;
    }
    case "text": {
      const text = str(n.text, UI_LIMITS.long, w, "text.text");
      return typeof text === "string"
        ? { type: "text", text, tone: tone(n.tone), size: oneOf(n.size, ["sm", "md"] as const), mono: n.mono === true }
        : null;
    }
    case "markdown": {
      const text = str(n.text, UI_LIMITS.long, w, "markdown.text");
      return typeof text === "string" ? { type: "markdown", text } : null;
    }
    case "code": {
      const text = str(n.text, UI_LIMITS.long, w, "code.text");
      const lang = str(n.lang, 30, w, "code.lang", true);
      return typeof text === "string" && lang !== null ? { type: "code", text, lang } : null;
    }
    case "badge": {
      const text = str(n.text, 60, w, "badge.text");
      return typeof text === "string" ? { type: "badge", text, tone: tone(n.tone) } : null;
    }
    case "stat": {
      const label = str(n.label, 80, w, "stat.label");
      const value = str(n.value, 80, w, "stat.value");
      const hint = str(n.hint, S, w, "stat.hint", true);
      if (typeof label !== "string" || typeof value !== "string" || hint === null) return null;
      return { type: "stat", label, value, tone: tone(n.tone), hint };
    }
    case "keyValue": {
      if (!Array.isArray(n.items)) return w.fail("keyValue.items must be a list");
      const items: { label: string; value: string; tone?: Tone }[] = [];
      for (const it of n.items.slice(0, 100)) {
        if (!it || typeof it !== "object") return w.fail("a keyValue item must be an object");
        const r = it as Record<string, unknown>;
        const label = str(r.label, 120, w, "keyValue label");
        const value = str(r.value, S, w, "keyValue value");
        if (typeof label !== "string" || typeof value !== "string") return null;
        items.push({ label, value, tone: tone(r.tone) });
      }
      return { type: "keyValue", items };
    }
    case "list": {
      if (!Array.isArray(n.items)) return w.fail("list.items must be a list");
      if (n.items.length > UI_LIMITS.items) return w.fail(`a list holds at most ${UI_LIMITS.items} items`);
      const items: UiListItem[] = [];
      // Items count as nodes: a list of a thousand rows is a thousand things
      // to draw, whatever the tree around it looks like.
      w.nodes += n.items.length;
      if (w.nodes > UI_LIMITS.nodes) return w.fail(`more than ${UI_LIMITS.nodes} nodes`);
      for (const it of n.items) {
        if (!it || typeof it !== "object") return w.fail("a list item must be an object");
        const r = it as Record<string, unknown>;
        const id = str(r.id, 200, w, "list item id");
        const title = str(r.title, S, w, "list item title");
        const subtitle = str(r.subtitle, S, w, "list item subtitle", true);
        const meta = str(r.meta, 120, w, "list item meta", true);
        if (typeof id !== "string" || typeof title !== "string" || subtitle === null || meta === null) return null;
        const a = r.action === undefined ? undefined : action(r.action, w, "list item action");
        if (a === null) return null;
        const to = openPr(r.open, w, "list item open");
        if (to === null) return null;
        items.push({ id, title, subtitle, meta, badges: badges(r.badges, w), action: a, open: to, selected: r.selected === true });
      }
      const empty = str(n.empty, S, w, "list.empty", true);
      return empty === null ? null : { type: "list", items, empty };
    }
    case "timeline": {
      if (!Array.isArray(n.items)) return w.fail("timeline.items must be a list");
      if (n.items.length > UI_LIMITS.items) return w.fail(`a timeline holds at most ${UI_LIMITS.items} items`);
      const items: UiTimelineItem[] = [];
      w.nodes += n.items.length;
      if (w.nodes > UI_LIMITS.nodes) return w.fail(`more than ${UI_LIMITS.nodes} nodes`);
      for (const it of n.items) {
        if (!it || typeof it !== "object") return w.fail("a timeline item must be an object");
        const r = it as Record<string, unknown>;
        const id = str(r.id, 200, w, "timeline item id");
        const title = str(r.title, S, w, "timeline item title");
        const body = str(r.body, UI_LIMITS.long, w, "timeline item body", true);
        if (typeof id !== "string" || typeof title !== "string" || body === null) return null;
        const a = r.action === undefined ? undefined : action(r.action, w, "timeline item action");
        if (a === null) return null;
        const to = openPr(r.open, w, "timeline item open");
        if (to === null) return null;
        const at = validMs(r.at);
        items.push({ id, at, title, body, tone: tone(r.tone), badges: badges(r.badges, w), action: a, open: to });
      }
      const empty = str(n.empty, S, w, "timeline.empty", true);
      return empty === null ? null : { type: "timeline", items, empty };
    }
    case "button": {
      const label = str(n.label, 80, w, "button.label");
      const a = action(n.action, w, "button.action");
      const confirm = str(n.confirm, S, w, "button.confirm", true);
      if (typeof label !== "string" || !a || confirm === null) return null;
      return {
        type: "button", label, action: a, confirm,
        tone: oneOf(n.tone, ["primary", "default", "danger"] as const), disabled: n.disabled === true,
      };
    }
    case "form": {
      const id = str(n.id, 120, w, "form.id");
      if (typeof id !== "string") return null;
      const fields = validateFields(n.fields);
      if (!fields.ok) return w.fail(fields.error);
      if (!n.submit || typeof n.submit !== "object") return w.fail("form.submit must be an object");
      const s = n.submit as Record<string, unknown>;
      const label = str(s.label, 80, w, "form.submit.label");
      const a = action(s.action, w, "form.submit.action");
      if (typeof label !== "string" || !a) return null;
      const values: Record<string, unknown> = {};
      if (n.values && typeof n.values === "object" && !Array.isArray(n.values)) {
        for (const f of fields.value) {
          // A drawn tree is served to every window and to any plugin holding a
          // read token; a secret has no business in it.
          if (f.type === "secret") continue;
          const v = coerceValue(f, (n.values as Record<string, unknown>)[f.key]);
          if (v !== undefined) values[f.key] = v;
        }
      }
      return { type: "form", id, fields: fields.value, values, submit: { label, action: a } };
    }
    case "progress": {
      const value = typeof n.value === "number" && Number.isFinite(n.value) ? Math.min(1, Math.max(0, n.value)) : undefined;
      const label = str(n.label, S, w, "progress.label", true);
      return label === null ? null : { type: "progress", value, label };
    }
    case "empty": {
      const title = str(n.title, S, w, "empty.title");
      const body = str(n.body, UI_LIMITS.long, w, "empty.body", true);
      if (typeof title !== "string" || body === null) return null;
      let a: UiNode | undefined;
      if (n.action !== undefined) {
        const one = node(n.action, w, depth + 1);
        if (!one) return null;
        a = one;
      }
      return { type: "empty", title, body, action: a };
    }
    case "link": {
      const text = str(n.text, S, w, "link.text");
      const href = safeHref(n.href);
      if (typeof text !== "string") return null;
      if (!href) return w.fail("link.href must be an https:// URL");
      return { type: "link", text, href };
    }
    case "divider":
      return { type: "divider" };
    default:
      return w.fail(`unknown node type ${JSON.stringify(String(n.type).slice(0, 40))}`);
  }
}

/** The whole screen, or the first reason it was refused. */
export function validateTree(raw: unknown): Ok<UiNode> | Err {
  let size: number;
  try { size = JSON.stringify(raw)?.length ?? 0; } catch { return { ok: false, error: "tree is not JSON" }; }
  if (size > UI_LIMITS.treeBytes) return { ok: false, error: `tree is ${size} bytes, over ${UI_LIMITS.treeBytes}` };
  const w = new Walk();
  const n = node(raw, w, 0);
  return n ? { ok: true, value: n } : { ok: false, error: w.error ?? "invalid tree" };
}

// ---------------------------------------------------------------------------
// Notes on a pull request.
//
// The other surface a plugin draws on is not a screen of its own but a PR
// the app already shows. A reviewer, a linter or a CI watcher all say the
// same kind of thing — "at this line of this commit, this" — so that is the
// shape, and PrPanel draws it beside GitHub's own threads, marked as local.
// Nothing here is ever sent to GitHub; the app has no path that would.

export type NoteSeverity = "critical" | "high" | "medium" | "low" | "idea" | "info";
export const NOTE_SEVERITIES: readonly NoteSeverity[] = ["critical", "high", "medium", "low", "idea", "info"];
export type NoteStatus = "open" | "resolved" | "dismissed";
export const NOTE_STATUSES: readonly NoteStatus[] = ["open", "resolved", "dismissed"];

export interface PrRef { repo: string; number: number }

/** A pass over a pull request: a review, a lint, a check. Notes hang off it,
 *  and the timeline shows it as one entry with its outcome. */
export interface PrRun {
  id: string;
  repo: string;
  number: number;
  sha?: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  title: string;
  summary?: string;
  meta?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface PrNote {
  id: string;
  runId?: string;
  repo: string;
  number: number;
  sha?: string;
  path?: string;
  line?: number;
  severity: NoteSeverity;
  title: string;
  body?: string;
  status: NoteStatus;
  /** Who set `status`. The person's word outranks the plugin's, and only
   *  the plugin's: a finding the reviewer itself marked resolved can be
   *  reopened by it when the bug comes back. */
  statusBy?: "person" | "plugin";
  createdAt: number;
  updatedAt: number;
}

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

export function validPrRef(repo: unknown, number: unknown): PrRef | null {
  if (typeof repo !== "string" || !REPO_RE.test(repo)) return null;
  const n = typeof number === "string" ? Number(number) : number;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 1e9) return null;
  return { repo, number: n };
}

export function validateRun(raw: unknown, now = Date.now()): Ok<PrRun> | Err {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "run must be an object" };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) return { ok: false, error: "run.id must be 1-120 of letters, digits, _ . : -" };
  const ref = validPrRef(r.repo, r.number);
  if (!ref) return { ok: false, error: "run needs repo as owner/name and a PR number" };
  const state = oneOf(r.state, ["queued", "running", "done", "failed", "cancelled"] as const);
  if (!state) return { ok: false, error: "run.state must be queued, running, done, failed or cancelled" };
  if (typeof r.title !== "string" || !r.title.trim() || r.title.length > UI_LIMITS.short) return { ok: false, error: "run.title must be 1-400 characters" };
  const out: PrRun = {
    id: r.id, ...ref, state, title: r.title,
    startedAt: validMs(r.startedAt) ?? now,
  };
  if (typeof r.sha === "string" && SHA_RE.test(r.sha)) out.sha = r.sha;
  if (typeof r.summary === "string") out.summary = r.summary.slice(0, UI_LIMITS.long);
  if (typeof r.meta === "string") out.meta = r.meta.slice(0, 200);
  const fin = validMs(r.finishedAt);
  if (fin !== undefined) out.finishedAt = fin;
  return { ok: true, value: out };
}

export function validateNote(raw: unknown, now = Date.now()): Ok<Omit<PrNote, "status" | "createdAt" | "updatedAt"> & { status?: NoteStatus }> | Err {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "note must be an object" };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) return { ok: false, error: "note.id must be 1-120 of letters, digits, _ . : -" };
  const ref = validPrRef(r.repo, r.number);
  if (!ref) return { ok: false, error: "note needs repo as owner/name and a PR number" };
  const severity = oneOf(r.severity, NOTE_SEVERITIES);
  if (!severity) return { ok: false, error: `note.severity must be one of ${NOTE_SEVERITIES.join(", ")}` };
  if (typeof r.title !== "string" || !r.title.trim() || r.title.length > UI_LIMITS.short) return { ok: false, error: "note.title must be 1-400 characters" };
  const out: Omit<PrNote, "status" | "createdAt" | "updatedAt"> & { status?: NoteStatus } = { id: r.id, ...ref, severity, title: r.title };
  void now;
  if (typeof r.runId === "string" && ID_RE.test(r.runId)) out.runId = r.runId;
  if (typeof r.sha === "string" && SHA_RE.test(r.sha)) out.sha = r.sha;
  if (typeof r.path === "string" && r.path.length <= 500 && !r.path.includes("\0") && !r.path.startsWith("/")) out.path = r.path;
  if (typeof r.line === "number" && Number.isInteger(r.line) && r.line > 0 && r.line < 1e7) out.line = r.line;
  if (typeof r.body === "string") out.body = r.body.slice(0, UI_LIMITS.long);
  const status = oneOf(r.status, NOTE_STATUSES);
  if (status) out.status = status;
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// What a manifest may declare it contributes. Declared, so the review screen
// can say it before anything is enabled: "adds a panel called Reviews",
// "writes notes on pull requests". A plugin that draws somewhere it did not
// declare is refused at the route, not trusted to behave.

export interface PanelContribution {
  id: string;
  title: string;
  icon?: string;
  /** Drawn as a live scene (pluginCanvas.ts) instead of a tree. Declared, so
   *  the approval screen says it and the manifest hash covers it: a plugin
   *  cannot start animating after it was approved as a static screen. */
  canvas?: true;
}

/**
 * A button in a pull request's header, next to the app's own. Pressing it
 * tells the plugin which pull request; what it does is the plugin's.
 *
 * The first one declared is the button; the rest live in the caret beside it.
 * A reviewer needs four ("review the new part", "review all of it", "watch
 * this one", "stop") and a header that grew four plugin buttons would be a
 * header nobody can read, so only one of them is ever on the row.
 */
export interface PrActionContribution { id: string; label: string }

export interface Contributes {
  settings?: Field[];
  panels?: PanelContribution[];
  prNotes?: boolean;
  prActions?: PrActionContribution[];
  /** Puts a badge and a sort order on Inbox rows. See `InboxAnnotation`. */
  inboxAnnotations?: boolean;
}

/** Icons a panel may name. A word, mapped to the app's own icon set, so a
 *  plugin cannot ship an image and every rail entry looks like the others. */
export const PANEL_ICONS = ["puzzle", "review", "check", "chart", "list", "bell", "bug", "book", "bolt", "eye"] as const;

/** A panel's id and an action's: one to 40 of a-z, 0-9 and -, starting with a letter. */
export const PANEL_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

export function validateContributes(raw: unknown): Ok<Contributes> | Err {
  if (raw === undefined) return { ok: true, value: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "contributes must be an object" };
  const c = raw as Record<string, unknown>;
  const out: Contributes = {};
  if (c.settings !== undefined) {
    const f = validateFields(c.settings);
    if (!f.ok) return { ok: false, error: `contributes.settings: ${f.error}` };
    out.settings = f.value;
  }
  if (c.panels !== undefined) {
    if (!Array.isArray(c.panels) || c.panels.length > 8) return { ok: false, error: "contributes.panels must be a list of at most 8" };
    out.panels = [];
    const seen = new Set<string>();
    for (const p of c.panels) {
      if (!p || typeof p !== "object") return { ok: false, error: "a panel must be an object" };
      const r = p as Record<string, unknown>;
      if (typeof r.id !== "string" || !PANEL_ID_RE.test(r.id)) return { ok: false, error: "panel id must be 1-40 of a-z, 0-9, - and start with a letter" };
      if (seen.has(r.id)) return { ok: false, error: `panel id "${r.id}" appears twice` };
      seen.add(r.id);
      if (typeof r.title !== "string" || !r.title.trim() || r.title.length > 40) return { ok: false, error: "panel title must be 1-40 characters" };
      const icon = oneOf(r.icon, PANEL_ICONS);
      if (r.canvas !== undefined && r.canvas !== true && r.canvas !== false) return { ok: false, error: "panel canvas must be true or false" };
      out.panels.push({ id: r.id, title: r.title.trim(), ...(icon ? { icon } : {}), ...(r.canvas === true ? { canvas: true as const } : {}) });
    }
  }
  if (c.prNotes !== undefined) {
    if (typeof c.prNotes !== "boolean") return { ok: false, error: "contributes.prNotes must be true or false" };
    out.prNotes = c.prNotes;
  }
  if (c.inboxAnnotations !== undefined) {
    if (typeof c.inboxAnnotations !== "boolean") return { ok: false, error: "contributes.inboxAnnotations must be true or false" };
    out.inboxAnnotations = c.inboxAnnotations;
  }
  if (c.prActions !== undefined) {
    // A few, short: the first shares a header row with the app's own buttons
    // and the others hang off its caret.
    if (!Array.isArray(c.prActions) || c.prActions.length > 5) return { ok: false, error: "contributes.prActions must be a list of at most 5" };
    out.prActions = [];
    const seen = new Set<string>();
    for (const a of c.prActions) {
      if (!a || typeof a !== "object") return { ok: false, error: "a pull request action must be an object" };
      const r = a as Record<string, unknown>;
      if (typeof r.id !== "string" || !PANEL_ID_RE.test(r.id)) return { ok: false, error: "action id must be 1-40 of a-z, 0-9, - and start with a letter" };
      if (seen.has(r.id)) return { ok: false, error: `action id "${r.id}" appears twice` };
      seen.add(r.id);
      if (typeof r.label !== "string" || !r.label.trim() || r.label.length > 28) return { ok: false, error: "action label must be 1-28 characters" };
      out.prActions.push({ id: r.id, label: r.label.trim() });
    }
  }
  return { ok: true, value: out };
}

/** Settings as the plugin will read them: every declared key present, typed,
 *  with the manifest's default where the person has not chosen. */
export function resolveSettings(fields: Field[] | undefined, stored: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? []) {
    const v = stored && Object.prototype.hasOwnProperty.call(stored, f.key) ? coerceValue(f, stored[f.key]) : undefined;
    out[f.key] = v !== undefined ? v : f.default !== undefined ? f.default : f.type === "list" || f.type === "multi" ? [] : f.type === "boolean" ? false : null;
  }
  return out;
}

/**
 * Settings as anything but the plugin itself may read them: every secret is
 * `null`, and `set` says which of them hold a value. The person sees "set,
 * replace, clear" and never the value; a screen, a log line or a second plugin
 * holding `full` scope reading `/plugins/settings` gets nothing to leak.
 */
export function redactSecrets(fields: Field[] | undefined, values: Record<string, unknown>): { values: Record<string, unknown>; set: string[] } {
  const out = { ...values };
  const set: string[] = [];
  for (const f of fields ?? []) {
    if (f.type !== "secret") continue;
    if (typeof out[f.key] === "string" && out[f.key] !== "") set.push(f.key);
    out[f.key] = null;
  }
  return { values: out, set };
}

// ------------------------------------------------------- inbox annotations

/**
 * What a plugin says about one Inbox row: a small badge, a tip, and a number
 * to order by. Vendor-neutral on purpose — the core draws it and sorts by it
 * and knows nothing about who produced it.
 *
 * It can decorate and reorder and nothing else. It cannot remove a row, mark
 * one read, or change what the row says.
 */
export interface InboxAnnotation {
  /** The plugin that wrote it; the sort choice is named after it. */
  plugin: string;
  /** 0..1, higher first. Ignored when `rank` is set. */
  score?: number;
  /** Any finite number, higher first. Wins over `score`. */
  rank?: number;
  badge?: { text: string; tone?: Tone };
  tip?: string;
}

/** What a plugin posts: the annotation, and the row and version it is about. */
export interface InboxAnnotationInput extends Omit<InboxAnnotation, "plugin"> {
  /** The notification thread id, as `InboxItem.id`. */
  id: string;
  /** The row's `at` it was made for. A row that has moved on (a new comment)
   *  is a different question, and the old answer stops showing. */
  updatedAt: number;
}

/** Control, zero-width and bidi-override characters: a badge that reads one way
 *  and is drawn another is a way to steer a person away from a row. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

export const ANNOTATION_LIMITS = { items: 500, id: 64, badge: 24, tip: 200 } as const;

export function validateAnnotations(raw: unknown): Ok<InboxAnnotationInput[]> | Err {
  if (!Array.isArray(raw)) return { ok: false, error: "items must be a list" };
  if (raw.length > ANNOTATION_LIMITS.items) return { ok: false, error: `at most ${ANNOTATION_LIMITS.items} items per post` };
  const out: InboxAnnotationInput[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, error: "an item must be an object" };
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || o.id.length > ANNOTATION_LIMITS.id) return { ok: false, error: `item.id must be 1-${ANNOTATION_LIMITS.id} characters` };
    const updatedAt = validMs(o.updatedAt);
    if (updatedAt === undefined) return { ok: false, error: "item.updatedAt must be epoch milliseconds" };
    const a: InboxAnnotationInput = { id: o.id, updatedAt };
    if (o.score !== undefined) {
      if (typeof o.score !== "number" || !Number.isFinite(o.score)) return { ok: false, error: "item.score must be a number" };
      a.score = Math.min(1, Math.max(0, o.score));
    }
    if (o.rank !== undefined) {
      if (typeof o.rank !== "number" || !Number.isFinite(o.rank)) return { ok: false, error: "item.rank must be a number" };
      a.rank = o.rank;
    }
    if (o.badge !== undefined) {
      const b = o.badge as Record<string, unknown> | null;
      if (!b || typeof b !== "object" || typeof b.text !== "string" || !b.text.trim()) return { ok: false, error: "item.badge needs text" };
      if (b.text.length > ANNOTATION_LIMITS.badge) return { ok: false, error: `badge text is longer than ${ANNOTATION_LIMITS.badge} characters` };
      const text = b.text.replace(INVISIBLE, "").trim();
      if (!text) return { ok: false, error: "item.badge needs text" };
      a.badge = { text, tone: tone(b.tone) };
    }
    if (o.tip !== undefined) {
      if (typeof o.tip !== "string") return { ok: false, error: "item.tip must be a string" };
      if (o.tip.length > ANNOTATION_LIMITS.tip) return { ok: false, error: `tip is longer than ${ANNOTATION_LIMITS.tip} characters` };
      a.tip = o.tip.replace(INVISIBLE, "");
    }
    out.push(a);
  }
  return { ok: true, value: out };
}
