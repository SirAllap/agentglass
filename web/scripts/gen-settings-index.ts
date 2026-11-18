#!/usr/bin/env bun
/*
 * Regenerates web/src/lib/settingsRows.gen.ts from the settings pages
 * themselves, instead of a list kept by hand.
 *
 * Before this, "does typing X find that row" was answered by a page's `kw`
 * bag — a sentence somebody wrote once and nobody re-reads when a row's
 * label changes. settings-search-reaches-every-row.test.ts already caught
 * `kw` drifting behind the rows that exist; this removes the hand-kept list
 * a layer further up by reading the row labels straight out of the JSX that
 * draws them, the same way that test reads `kw` out of the TABS array.
 *
 * A pane's content is either drawn inline in SettingsModal.tsx, inside its
 * own `{pane === "x" && …}` block, or by a named component such as
 * `<HooksPane` — which may itself be defined inside SettingsModal.tsx (most
 * of the "status" panes are) or in its own file under web/src/components.
 * This walks both.
 *
 * Ceiling: a row whose label or hint is built from a variable or a template
 * literal — `label={statusLabel}`, `label={\`Port \${port}\`}` — is invisible
 * to a regex over source text, so it is not indexed here. Its PAGE is still
 * reachable by that page's `kw`, which is unaffected by this file; only the
 * per-row jump (Enter on a search result, the command palette's row entry)
 * cannot land on that one row. Nested components deeper than one level (a
 * component that itself renders another component that renders a row) are
 * not indexed, except for the panes in DEEP_PANES, which are followed one level more, for the same reason: this script does not evaluate the
 * tree, it reads text.
 *
 * Regenerate with `bun run gen:settings-index` from web/.
 */
import { autoCheckHint } from "../src/lib/aboutRules.ts";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADVANCED_ROWS } from "../src/components/settings/pages/advancedRows.ts";
import { INSPECT_ROWS } from "../src/components/settings/pages/inspectRows.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = resolve(HERE, "../src/components");
const MODAL_PATH = join(COMPONENTS_DIR, "SettingsModal.tsx");
const OUT_PATH = resolve(HERE, "../src/lib/settingsRows.gen.ts");

// SettingRow/Row/Toggle/Fold/Select are the shared primitives; the rest are
// local wrapper components (a few per settings page, `const X = (...) =>` or
// `function X<T>(...)`) that also take a `label`/`hint` pair and draw one
// operable row — a stepper, a labelled radio group, a bulk-select button.
const ROW_TAGS = ["SettingRow", "Row", "Toggle", "Fold", "Select", "Stepper", "Choice", "Bulk", "Path", "MiniBtn", "SoundRow", "Dep", "ShellRow", "DoorSwitchRow", "SearchRow"];

type Row = { pane: string; section: string; label: string; hint: string; settingId?: string; agentExempt?: true; agentNever?: string };
type Page = { id: string; label: string };

/** Every .tsx file under web/src/components, recursively, in name order: two files that define the same component must not pick a winner by the order a disk lists them. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const ALL_FILES = walk(COMPONENTS_DIR);
const FILE_TEXT = new Map<string, string>();
function textOf(path: string): string {
  let t = FILE_TEXT.get(path);
  if (t === undefined) { t = readFileSync(path, "utf8"); FILE_TEXT.set(path, t); }
  return t;
}

/** The file (if any) that defines `function Name(` — its own, or an
 *  `export function Name(`. SettingsModal.tsx is included: many of the
 *  panes named in a `{pane === "x" &&}` block (HooksPane, ActivityPane,
 *  AboutPane…) are defined further down in the same file. */
function fileDefining(component: string): string | null {
  // `<[^(]*>` allows a generic parameter list — `function Choice<T extends
  // string>(` — between the name and the opening paren.
  const re = new RegExp(`(^|\\n)(?:export )?function ${component}(?:<[^(]*>)?\\(`);
  for (const f of ALL_FILES) if (re.test(textOf(f))) return f;
  return null;
}

/** From a defining file, the slice of text that is that component's own
 *  body — from its `function Name(` to the next top-level `function ` (a
 *  line starting in column 0), or the end of the file. Not a brace-matcher:
 *  every component here is one of several siblings at the top of its file,
 *  never nested inside another, so the next top-level declaration is a
 *  reliable fence. */
function componentBody(path: string, component: string): string {
  const src = textOf(path);
  const at = src.search(new RegExp(`(^|\\n)(?:export )?function ${component}(?:<[^(]*>)?\\(`));
  if (at < 0) return "";
  const from = src.indexOf("function", at);
  const nextFn = src.slice(from + 8).search(/\n(?:export )?function \w+\(/);
  return nextFn < 0 ? src.slice(from) : src.slice(from, from + 8 + nextFn);
}

/** Section markers in a slice of source: `<Section title="…"` and the plain
 *  `agx-settings-head-t` heading span, each with the offset it starts at. */
function sectionMarkers(text: string): { at: number; title: string }[] {
  const out: { at: number; title: string }[] = [];
  for (const m of text.matchAll(/<Section\b[^>]*?\stitle="([^"]*)"/g)) out.push({ at: m.index!, title: m[1]! });
  for (const m of text.matchAll(/<DangerZone\b/g)) out.push({ at: m.index!, title: "Danger zone" });
  for (const m of text.matchAll(/<MoreOptions\b/g)) out.push({ at: m.index!, title: "More options" });
  for (const m of text.matchAll(/<SettingsCard\b[^>]*?\stitle="([^"]*)"/g)) out.push({ at: m.index!, title: m[1]! });
  // A card with no visible title (its Section already names it) is still found under that name.
  for (const m of text.matchAll(/<SettingsCard\s+label="([^"]*)"/g)) out.push({ at: m.index!, title: m[1]! });
  for (const m of text.matchAll(/agx-settings-head-t"[^>]*>([^<]{1,80})</g)) out.push({ at: m.index!, title: m[1]!.trim() });
  out.sort((a, b) => a.at - b.at);
  return out;
}

function sectionFor(markers: { at: number; title: string }[], at: number): string {
  let title = "";
  for (const m of markers) { if (m.at > at) break; title = m.title; }
  return title;
}

/** Rows drawn directly (not by a sub-component) inside a slice of source: a
 *  literal `label="…"` reached from one of ROW_TAGS, with whatever `hint="…"`
 *  literal follows it before the next label or a generous 300-char horizon. */
function rowsIn(text: string, pane: string): Row[] {
  const markers = sectionMarkers(text);
  // `(?<!aria-)` — an `aria-label` is not a settings row's label, it is the
  // accessible name of a bare icon button (the stepper's − and + controls).
  const labels = [...text.matchAll(/(?<!aria-)\blabel="([^"]{1,90})"/g)];
  const rows: Row[] = [];
  for (let i = 0; i < labels.length; i++) {
    const m = labels[i]!;
    const before = text.slice(Math.max(0, m.index! - 1000), m.index!);
    // A trailing space (or newline) after the name is what tells a JSX
    // opening tag apart from a TypeScript generic — `<Stepper label=` vs.
    // `useState<TaskLanding>(...)`, where the name is immediately followed
    // by `>`. Without this, every generic type parameter in scope reads as
    // the row's tag, and a `label` near a `useState<Foo>` call is silently
    // dropped or mis-attributed.
    // `(?:<[^<>]*>)?` allows an explicit generic argument on the tag itself
    // — `<Choice<"split" | "inline"> label=…` — between the name and the
    // attribute list.
    const tagMatch = [...before.matchAll(/<([A-Z][A-Za-z0-9]*)(?:<[^<>]*>)?[\s]/g)].pop();
    if (!tagMatch || !ROW_TAGS.includes(tagMatch[1]!)) continue;
    const label = m[1]!;
    const horizon = Math.min(m.index! + 300, labels[i + 1]?.index ?? text.length);
    const after = text.slice(m.index! + m[0].length, horizon);
    // A hint chosen by a pure function of the row's state (`hint={autoCheckHint(auto)}`): indexed as its off-state sentence.
    const fnHint = after.match(/\bhint=\{(\w+)\(/)?.[1] === "autoCheckHint" ? autoCheckHint(false) : undefined;
    const hintMatch = after.match(/\b(?:hint|help)="([^"]{1,140})"/) ?? (fnHint ? [fnHint, fnHint] : null);
    // A row whose help comes from a page model (`help={help("sound", "Notification sound")}`): the sentence is in the model's `{ label, help }` table.
    const modelHelp = hintMatch ? undefined : /\bhelp=\{help\(/.test(after.slice(0, 400)) ? modelHelps().get(label) : undefined;
    // Which setting an agent reaches through this row, and the rows that are
    // not settings at all (a reset button, a read-out). Both are written BEFORE
    // `label=` in the tag, so they are found in the same text the tag name was:
    // from the tag's opening to the label, nothing past it to mistake for the
    // next row's.
    const tagText = before.slice(tagMatch.index!);
    // A row that draws one control per member of a family names it with a template
    // (`rail.place.${v.id}`): indexed as the family, `rail.place.*`.
    const family = tagText.match(/\bsettingId=\{`([A-Za-z0-9.]+\.)\$\{[^}`]+\}`\}/)?.[1];
    const settingId = tagText.match(/\bsettingId="([^"]{1,80})"/)?.[1] ?? (family ? `${family}*` : undefined);
    // A row of the shell (settings/shell/SettingRow.tsx) says what it is with `kind=`; one with no settingId is not a setting.
    const shellRow = /\bkind=/.test(tagText);
    const agentExempt = /\bagentExempt\b/.test(tagText) || (shellRow && !settingId && !/\bagentNever=/.test(tagText));
    // A row an agent must not reach, with the reason on the row itself.
    const agentNever = tagText.match(/\bagentNever="([^"]{1,240})"/)?.[1];
    rows.push({
      pane, section: sectionFor(markers, m.index!), label, hint: hintMatch ? hintMatch[1]! : (modelHelp ?? ""),
      ...(settingId ? { settingId } : {}), ...(agentExempt ? { agentExempt: true as const } : {}), ...(agentNever ? { agentNever } : {}),
    });
  }
  rows.push(...tableRowsIn(text, pane, markers));
  // The page header's one action (`useReportHead("id", … { action: { label: "New prompt" } } …`) is drawn by the shell, not as a row: indexed so a search for it lands on its page.
  for (const m of text.matchAll(/useReportHead\("[^"]+",[^;]{0,200}?action: \{ label: "([^"]{1,60})"/g)) rows.push({ pane, section: "", label: m[1]!, hint: "The button at the top of the page.", agentExempt: true });
  // A page-local helper `const row = (label, help, control) => <SettingRow … />` called as `row("Work starts", hint("…") | "…", …)`: the label is the first literal argument.
  for (const m of text.matchAll(/\brow\("([^"]{1,90})",\s*(?:hint\(\s*)?(?:"([^"]{0,140})")?([^<]{0,200})/g)) {
    // A hint chosen by a ternary (`noDays ? "None ticked…" : "Picks the days…"`) is indexed as its default: the last literal.
    const ternary = m[2] === undefined ? [...m[3]!.matchAll(/"([^"]{1,140})"/g)].pop()?.[1] : undefined;
    rows.push({ pane, section: sectionFor(markers, m.index!), label: m[1]!, hint: m[2] ?? ternary ?? "", agentExempt: true });
  }
  // A row drawn by hand rather than through a row primitive names itself for the jump (`data-row={rowId("Folder path or git URL")}`): that literal is the row's label, and a `…hint">sentence<` inside it is its hint.
  for (const m of text.matchAll(/data-row=\{rowId\("([^"]{1,90})"\)\}/g)) {
    const hint = text.slice(m.index!, m.index! + 800).match(/className="[^"]*\bagx-[\w-]*hint\b[^"]*">([^<{]{1,140})</)?.[1] ?? "";
    rows.push({ pane, section: sectionFor(markers, m.index!), label: m[1]!, hint, agentExempt: true });
  }
  // A row with a stored key whose label is chosen at run time (`label={on ? "A is on" : "A is off"}`): every literal in the expression is a label a reader may type, and the first carries the key.
  for (const m of text.matchAll(/\bsettingId="([A-Za-z0-9.]+)"/g)) {
    const tagAt = text.lastIndexOf("<", m.index!);
    const tagTag = text.slice(tagAt + 1, tagAt + 20).match(/^([A-Z]\w*)/)?.[1];
    if (!tagTag || !ROW_TAGS.includes(tagTag)) continue;
    const near = text.slice(tagAt, m.index! + 700);
    if (/\blabel="/.test(near.split(/\n\s*\/?>\s*\n/)[0]!)) continue;
    const expr = near.match(/\blabel=\{([^}]{1,240})\}/)?.[1];
    // `label={COPY["id"].label}` is resolved from the table by the loop below, with its real words; its id is not a label.
    if (/^COPY\[/.test(expr ?? "")) continue;
    const lits = [...(expr ?? "").matchAll(/"([^"]{2,90})"/g)].map((x) => x[1]!);
    lits.forEach((l, i) => rows.push({ pane, section: sectionFor(markers, m.index!), label: l, hint: "", ...(i === 0 ? { settingId: m[1]! } : {}), agentExempt: i === 0 ? undefined : true } as Row));
  }
  // A row whose words come from a table by id: `label={COPY["tmux.lastCapture"].label}`.
  for (const m of text.matchAll(/label=\{COPY\["([^"]+)"\]\.label\}/g)) {
    const w = rowTable().get(m[1]!);
    // The row names its setting itself (`settingId="cleanup.include"` before the label) when the registry has no entry for it.
    const named = text.slice(Math.max(0, m.index! - 200), m.index!).includes(`settingId="${m[1]!}"`);
    if (w) rows.push({ pane, section: sectionFor(markers, m.index!), label: w.label, hint: w.help, ...(registryIds().has(m[1]!) || named ? { settingId: m[1]! } : { agentExempt: true as const }) });
  }
  return rows;
}

/** Page rows kept as data (settings/pages/*Rows.ts and pageRows.ts): id -> label and help. */
let ROW_TABLE: Map<string, { label: string; help: string }> | null = null;
function rowTable(): Map<string, { label: string; help: string }> {
  if (ROW_TABLE) return ROW_TABLE;
  ROW_TABLE = new Map();
  const dir = join(COMPONENTS_DIR, "settings", "pages");
  for (const f of readdirSync(dir).filter((n) => /Rows\.ts$/.test(n) || n === "pageRows.ts")) {
    for (const m of readFileSync(join(dir, f), "utf8").matchAll(/\{ id: "([^"]+)", section: "[^"]*", label: "([^"]*)", help: "([^"]*)"/g)) ROW_TABLE.set(m[1]!, { label: m[2]!, help: m[3]! });
  }
  return ROW_TABLE;
}
let REGISTRY_IDS: Set<string> | null = null;
function registryIds(): Set<string> {
  if (!REGISTRY_IDS) REGISTRY_IDS = new Set([...readFileSync(resolve(HERE, "../src/lib/settingsRegistry.ts"), "utf8").matchAll(/\bid: "([A-Za-z0-9.]+)"/g)].map((m) => m[1]!));
  return REGISTRY_IDS;
}
let MODEL_HELPS: Map<string, string> | null = null;
function modelHelps(): Map<string, string> {
  if (MODEL_HELPS) return MODEL_HELPS;
  MODEL_HELPS = new Map();
  const dir = join(COMPONENTS_DIR, "settings", "pages");
  for (const f of readdirSync(dir).filter((n) => /Model\.ts$/.test(n))) {
    for (const m of readFileSync(join(dir, f), "utf8").matchAll(/\{ label: "([^"]+)", help: "([^"]+)" \}/g)) MODEL_HELPS.set(m[1]!, m[2]!);
  }
  return MODEL_HELPS;
}
/** A shell row that takes its words from a table: `<SettingRow kind="control" {...row("terminal.font")} …/>`,
 *  or a slot inside a sentence row that does the same: `<SentenceSlot kind="switch" {...row("browser.importHistory")} …/>`. */
function tableRowsIn(text: string, pane: string, markers: { at: number; title: string }[]): Row[] {
  const out: Row[] = [];
  for (const m of text.matchAll(/<(?:SettingRow|SentenceSlot)\b[^>]*?\{\.\.\.row\("([^"]+)"\)\}/g)) {
    const id = m[1]!;
    const w = rowTable().get(id);
    if (!w) continue;
    const never = m[0].match(/\bagentNever="([^"]{1,240})"/)?.[1];
    out.push({ pane, section: sectionFor(markers, m.index!), label: w.label, hint: w.help, ...(registryIds().has(id) || m[0].includes(`settingId="${id}"`) ? { settingId: id } : never ? {} : { agentExempt: true as const }), ...(never ? { agentNever: never } : {}) });
  }
  // A row whose words go to a child that draws the SettingRow itself: `<VaultSites signOut={row("browser.vaultSignOut")} …/>`,
  // or a wrapper that anchors one: `data-row={rowId(row("browser.vaultSites").label)}`.
  for (const m of text.matchAll(/(?:\b[a-z]\w*=\{row\("([^"]+)"\)\}|rowId\(row\("([^"]+)"\)\.label\))/g)) {
    const id = (m[1] ?? m[2])!;
    const w = rowTable().get(id);
    if (!w) continue;
    out.push({ pane, section: sectionFor(markers, m.index!), label: w.label, hint: w.help, ...(registryIds().has(id) ? { settingId: id } : { agentExempt: true as const }) });
  }
  // One row per id of a literal list: `(["a.x", "a.y"] as const).map((id) => … <SettingRow {...row(id)} …`.
  for (const m of text.matchAll(/\(\[((?:"[^"]+",?\s*)+)\] as const\)\.map\(\(id\) => \{[\s\S]*?\{\.\.\.row\(id\)\}/g)) {
    for (const id of [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!)) {
      const w = rowTable().get(id);
      if (!w) continue;
      out.push({ pane, section: sectionFor(markers, m.index!), label: w.label, hint: w.help, ...(registryIds().has(id) ? { settingId: id } : { agentExempt: true as const }) });
    }
  }
  return out;
}

const PAGES_DIR = resolve(HERE, "../src/components/settings/pages");
const DOOR_SPECS_PATH = resolve(HERE, "../src/components/orchestration/doorSpecs.ts");
const ENV_LIMITS_PATH = resolve(HERE, "../../shared/envLimits.ts");
const ENGINE_HINT_TEXT = "Shown as stored. Edit it in Engines; an agent changes it through the settings door.";

/** One door spec entry's id, label and hint, read from the source text of a `{ id: "…", … }` entry. */
function doorEntry(entry: string, consts: Record<string, string>): { id: string; label: string; hint: string } | null {
  const id = entry.match(/\bid:\s*"([^"]+)"/)?.[1];
  const label = entry.match(/\blabel:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  if (!id || label === undefined) return null;
  const quoted = entry.match(/\b(?:hint|help):\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  const tpl = entry.match(/\bhint:\s*`([^`]*)`/)?.[1];
  const named = entry.match(/\bhint:\s*([A-Z_]+)\b/)?.[1];
  let hint = quoted ?? (tpl !== undefined ? tpl.replace(/\$\{(\w+)\}/g, (_, k: string) => consts[k] ?? "") : named ? consts[named] ?? "" : "");
  hint = hint.replace(/\\"/g, '"');
  return { id, label: label.replace(/\\"/g, '"'), hint: hint.length > 140 ? "" : hint };
}

/** The entries of `export const NAME … = [` in a source file. */
function arrayEntries(src: string, name: string): string[] {
  const at = src.search(new RegExp(`(?:export )?const ${name}\\b[^=]*=\\s*\\[`));
  if (at < 0) return [];
  const rest = src.slice(at);
  const end = rest.search(/\n\];/);
  return (end < 0 ? rest : rest.slice(0, end)).split(/\n  (?=\{ )/).slice(1);
}

/** Rows a page draws from a spec table rather than from a JSX label: `<DoorCard title="T" specs={NAME}` and `<EnvLimitsCard`.
 *  Each spec is one row with its stored key, so the key is found by search and has one home, the page that draws the card. */
function doorRowsIn(text: string, pane: string): Row[] {
  const out: Row[] = [];
  const specSrc = textOf(DOOR_SPECS_PATH);
  const consts = { ENGINE_HINT: ENGINE_HINT_TEXT };
  for (const m of text.matchAll(/<DoorCard\s+title="([^"]*)"\s+specs=\{(\w+)\}/g)) {
    for (const e of arrayEntries(specSrc, m[2]!)) {
      const d = doorEntry(e, consts);
      if (d) out.push({ pane, section: m[1]!, label: d.label, hint: d.hint, settingId: d.id });
    }
  }
  // A settings page draws a spec table of its own, in its own file: `<DoorRowList title="T" specs={NAME} …/>`.
  for (const m of text.matchAll(/<DoorRowList\s+title="([^"]*)"\s+specs=\{(\w+)\}/g)) {
    for (const f of readdirSync(PAGES_DIR).filter((n) => n.endsWith(".tsx"))) {
      const src = textOf(resolve(PAGES_DIR, f));
      const entries = arrayEntries(src, m[2]!);
      if (!entries.length) continue;
      for (const e of entries) { const d = doorEntry(e, consts); if (d) out.push({ pane, section: m[1]!, label: d.label, hint: d.hint, settingId: d.id }); }
      break;
    }
  }
  for (const m of text.matchAll(/<EnvLimitsCard\b[^>]*\/>/g)) {
    const title = m[0].match(/\stitle="([^"]*)"/)?.[1] ?? "Limits";
    const src = textOf(ENV_LIMITS_PATH);
    const env = { START: src.match(/const START = "([^"]*)"/)?.[1] ?? "" };
    for (const e of arrayEntries(src, "ENV_LIMITS")) {
      const d = doorEntry(e, env);
      if (d) out.push({ pane, section: title, label: d.label, hint: d.hint, settingId: d.id });
    }
  }
  return out;
}

/** The slice of OrchestrationView that draws the Roles & limits page (`part="limits"`). */
const LIMITS_END = '\n  return (\n    <FlowReviewPage root';
/** One `if (p.part === "<name>") {` block of OrchestrationView: it ends at the next part block or at the flow page's return. */
function partText(body: string, name: string): string {
  const a = body.indexOf(`if (p.part === "${name}") {`);
  if (a < 0) return "";
  const ends = [body.indexOf("\n  if (p.part === ", a + 10), body.indexOf(LIMITS_END, a)].filter((i) => i >= 0);
  return ends.length ? body.slice(a, Math.min(...ends)) : "";
}
const limitsPartText = (body: string): string => partText(body, "limits");
/** The orchestration page without the part that belongs to Roles & limits: those rows have one home. */
function withoutLimitsPart(body: string): string {
  let out = body;
  for (const n of ["limits", "permWorkers", "permMain"]) { const part = partText(out, n); if (part) out = out.replace(part, ""); }
  return out;
}

/** Capitalised JSX tags in a slice of source that name a component this repo
 *  defines under web/src/components, minus the small set of primitives that
 *  are not pages of their own (they are how a ROW draws, not what a pane is
 *  made of). */
const SKIP_TAGS = new Set(["SettingRow", "Row", "Toggle", "Fold", "Select", "Switch", "Section", "SettingsCard", "Fragment",
  // The shell pages draw run-time bodies from these; their rows are not the page's static rows.
  "JiraPane", "ClickUpPane", "Recipe", "Seen", "WorkflowMap", "CountedPicker", "StatusPopover", "CopyClickUpSteps", "PrView", "CardView", "SettingsPage", "DangerZone"]);
function subComponentsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)) {
    const name = m[1]!;
    if (!SKIP_TAGS.has(name)) found.add(name);
  }
  return [...found];
}

/** Panes whose container hands what it reads to a view that draws the rows. Opt-in: following every pane two levels adds rows to pages nobody asked about. */
const DEEP_PANES = new Set(["jira", "hooks"]);
/** How many component boundaries to follow inside a deep pane. Orchestration
 *  draws its configuration through a view whose panel is one level further:
 *  pane → OrchestrationPane → OrchestrationView → BlockPanel. */
const DEEP_DEPTH: Readonly<Record<string, number>> = { plugins: 2, recipes: 2, understudy: 2, orchestration: 3, fplan: 2, polaris: 3, permMain: 2, permWorkers: 2, permBrowser: 1, permOut: 2 };

/** Panes drawn by a page file under settings/pages: filled in by buildOutput before any pane is read. */
const PAGE_PANES = new Set<string>();
function rowsForPane(pane: string, block: string, seenComponents: Set<string>, depth = 0): Row[] {
  const own = (t: string) => [...rowsIn(t, pane), ...doorRowsIn(t, pane)];
  const rows = own(block);
  for (const comp of subComponentsIn(block)) {
    if (seenComponents.has(`${pane}:${comp}`)) continue;
    seenComponents.add(`${pane}:${comp}`);
    const file = fileDefining(comp);
    if (!file) continue; // not a component this repo defines (an icon, a DOM-ish tag, etc.)
    if (file.includes("/settings/previews/")) continue; // a drawing of the app on invented data, not rows a person can set
    let body = componentBody(file, comp);
    if (!body) continue;
    if (comp === "OrchestrationView") body = withoutLimitsPart(body);
    rows.push(...own(body));
    // A pane whose container hands what it reads to a view (JiraPane -> JiraSettingsView) has its rows one level further down.
    const deep = DEEP_DEPTH[pane] ?? (DEEP_PANES.has(pane) ? 1 : 0);
    // A page cut out of the modal (settings/pages/*Page.tsx) is followed to the end: the row components it renders (UsageKeyCard, AgentTrustRow…) live in files the first level never opens.
    const through = PAGE_PANES.has(pane) ? 6 : deep;
    if (depth < through) rows.push(...rowsForPane(pane, body, seenComponents, depth + 1).slice(own(body).length));
  }
  return rows;
}

const WORKER_ROLES_PATH = resolve(HERE, "../../shared/workerRoles.ts");
const PERMISSIONS_PAGE_PATH = resolve(HERE, "../src/components/settings/pages/PermissionsPage.tsx");
const ENGINES_PAGE_PATH = resolve(HERE, "../src/components/settings/pages/EnginesUsagePage.tsx");
const PERM_PANE_PATH = resolve(HERE, "../src/components/orchestration/OrchestrationPane.tsx");

/**
 * Rows whose label is built from a list at run time (`A worker's shell may run ${cmd}`,
 * `{w.label}`), which the scan above cannot read. Each is expanded here from the
 * same list the page maps over, so a switch added to the list is searchable with
 * no second edit. The ids are the ones the page writes.
 */
function expandedRows(): Row[] {
  const out: Row[] = [];
  const commands = [...(textOf(WORKER_ROLES_PATH).match(/SWITCHABLE_COMMANDS[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const hint = textOf(PERM_PANE_PATH).match(/hint="(Open by default\. Closed: the lock refuses it[^"]*)"/)?.[1] ?? "";
  for (const cmd of commands) out.push({ pane: "permWorkers", section: "Commands", label: `A worker's shell may run ${cmd}`, hint, settingId: `workers.commands.${cmd.replace(/ /g, "-")}` });
  const doors = [...textOf(PERM_PANE_PATH).matchAll(/<AppDoorToggle door="([a-z-]+)"[^>]*?hint="([^"]*)"/g)];
  for (const d of doors) out.push({ pane: "permWorkers", section: "agentglass tools", label: `A worker's shell may run ${d[1]}`, hint: d[2]!, settingId: `workers.appDoors.${d[1]}` });
  // Engines & usage: one switch per provider in the top bar, from the BAR table the page maps over (`usage.bar.<id>`).
  const barSrc = textOf(ENGINES_PAGE_PATH);
  for (const m of barSrc.matchAll(/\{ id: "(\w+)", label: "([^"]+)", help: "([^"]+)" \}/g)) {
    out.push({ pane: "engines", section: "Usage bar", label: m[2]!, hint: m[3]!, settingId: `usage.bar.${m[1]}` });
  }
  const perm = textOf(PERMISSIONS_PAGE_PATH);
  for (const k of perm.matchAll(/\{ kind: "([a-z]+)", label: "([^"]+)", help: "([^"]+)" \}/g)) {
    out.push({ pane: "perm", section: "", label: k[2]!, hint: k[3]!, settingId: `jira.writes.${k[1]}` });
  }
  return out;
}


/** Builds the generated file's text without writing it — the part
 *  settings-index-rows.test.ts calls directly to check the committed file is
 *  fresh, without shelling out to a second bun process. */
export function buildOutput(): string {
  const modalSrc = textOf(MODAL_PATH);

  const pages: Page[] = [];
  const tabRe = /\{ id: "([A-Za-z-]+)"(?: as const)?, label: "([^"]*)", group: "[^"]*"(?: as const)?, kw: "([^"]*)"/g;
  for (const m of modalSrc.matchAll(tabRe)) pages.push({ id: m[1]!, label: m[2]! });

  const blockMarks = [...modalSrc.matchAll(/\{show\("([A-Za-z-]+)"\) &&/g)];
  const seenComponents = new Set<string>();
  const rows: Row[] = [];
  for (let i = 0; i < blockMarks.length; i++) {
    const m = blockMarks[i]!;
    const pane = m[1]!;
    let body = modalSrc.slice(m.index!, i + 1 < blockMarks.length ? blockMarks[i + 1]!.index! : modalSrc.length);
    // A page cut out of the modal (components/settings/pages/*.tsx) is read as if
    // it were still inline: its own body joins the block, so what it draws is
    // found at the same depth as before the move.
    for (const pm of body.matchAll(/<(\w+SettingsPage) c=\{pageCtx\}/g)) {
      const file = fileDefining(pm[1]!);
      if (file) body = body.replace(pm[0], "<Fragment") + "\n" + componentBody(file, pm[1]!);
    }
    // A page built on the shell (pages/<Name>Page.tsx) is read the same way; its local components are followed like any other.
    for (const pm of body.matchAll(/<([A-Z]\w*Page)\b[^>]*\/>/g)) {
      const file = fileDefining(pm[1]!);
      if (file?.includes("/settings/pages/")) { body = body.replace(pm[0], "<Fragment />") + "\n" + componentBody(file, pm[1]!); PAGE_PANES.add(pane); }
    }
    // Roles & limits draws only the limits part of OrchestrationPane: index that part, not the whole component.
    if (pane === "workers") {
      const orch = fileDefining("OrchestrationView");
      body = body.replace('<OrchestrationPane part="limits" />', orch ? limitsPartText(componentBody(orch, "OrchestrationView")) : "");
      // WorkersPage is followed by name; the two row components beside it in its file are not, so they join the block.
      const wp = fileDefining("WorkersPage");
      if (wp) body += "\n" + componentBody(wp, "MemoryRow") + "\n" + componentBody(wp, "ForgetRolesRow");
    }
    // The Permissions pages draw their part of the same view: index that part, not the whole component.
    for (const [id, part] of [["permWorkers", "permWorkers"], ["permMain", "permMain"]] as const) {
      const orch = fileDefining("OrchestrationView");
      if (pane === id) body = body.replace(new RegExp(`<OrchestrationPane part="${part}" />`), orch ? partText(componentBody(orch, "OrchestrationView"), part) : "");
    }
    rows.push(...rowsForPane(pane, body, seenComponents));
  }

  rows.push(...expandedRows());
  // The Advanced and Inspect pages draw from data tables: one row each, bound to the setting id the door reads.
  for (const r of ADVANCED_ROWS) rows.push({ pane: "advanced", section: r.section, label: r.label, hint: r.touch, ...(r.id ? { settingId: r.id } : r.agentNever ? { agentNever: r.agentNever } : { agentExempt: true as const }) });
  for (const r of INSPECT_ROWS) rows.push({ pane: "inspect", section: r.section, label: r.label, hint: r.help, settingId: r.id });

  rows.sort((a, b) => a.pane === b.pane ? (a.section === b.section ? a.label.localeCompare(b.label) : a.section.localeCompare(b.section)) : a.pane.localeCompare(b.pane));
  pages.sort((a, b) => a.id.localeCompare(b.id));

  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const rowLines = rows.map((r) =>
    `  { pane: "${r.pane}", section: "${esc(r.section)}", label: "${esc(r.label)}", hint: "${esc(r.hint)}"`
    + `${r.settingId ? `, settingId: "${esc(r.settingId)}"` : ""}${r.agentExempt ? ", agentExempt: true" : ""}${r.agentNever ? `, agentNever: "${esc(r.agentNever)}"` : ""} },`).join("\n");
  const pageLines = pages.map((p) => `  { id: "${p.id}", label: "${esc(p.label)}" },`).join("\n");

  const out = `/*
 * GENERATED by web/scripts/gen-settings-index.ts — do not hand-edit.
 * Regenerate with \`bun run gen:settings-index\` from web/ after changing a
 * settings page (a row's label or hint, a Section title, or which component
 * a pane block renders). settings-index-rows.test.ts fails the build when
 * this file is stale.
 */
/** \`settingId\` is the SettingDef an agent reaches through the row (web/src/lib/settingsRegistry.ts);
 *  \`agentExempt\` marks a row that is not a setting (a reset button, a read-out);
 *  \`agentNever\` marks a setting an agent must not reach, and says why. */
export type SettingsRowRaw = { pane: string; section: string; label: string; hint: string; settingId?: string; agentExempt?: true; agentNever?: string };
export type SettingsPageRaw = { id: string; label: string };

export const SETTINGS_ROWS: SettingsRowRaw[] = [
${rowLines}
];

export const SETTINGS_PAGES: SettingsPageRaw[] = [
${pageLines}
];
`;
  return out;
}

function main() {
  const out = buildOutput();
  writeFileSync(OUT_PATH, out);
  const rows = (out.match(/{ pane: /g) ?? []).length;
  const pages = (out.match(/{ id: /g) ?? []).length;
  console.log(`wrote ${rows} rows, ${pages} pages to ${OUT_PATH}`);
}

// Bun sets import.meta.main on the entry module — this only runs the
// generator's side effect (writing the file) when the script is invoked
// directly, not when a test imports buildOutput().
if (import.meta.main) main();
