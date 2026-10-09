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
 * also not indexed, for the same reason: this script does not evaluate the
 * tree, it reads text.
 *
 * Regenerate with `bun run gen:settings-index` from web/.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = resolve(HERE, "../src/components");
const MODAL_PATH = join(COMPONENTS_DIR, "SettingsModal.tsx");
const OUT_PATH = resolve(HERE, "../src/lib/settingsRows.gen.ts");

// SettingRow/Row/Toggle/Fold/Select are the shared primitives; the rest are
// local wrapper components (a few per settings page, `const X = (...) =>` or
// `function X<T>(...)`) that also take a `label`/`hint` pair and draw one
// operable row — a stepper, a labelled radio group, a bulk-select button.
const ROW_TAGS = ["SettingRow", "Row", "Toggle", "Fold", "Select", "Stepper", "Choice", "Bulk", "Path", "MiniBtn", "SoundRow"];

type Row = { pane: string; section: string; label: string; hint: string; settingId?: string; agentExempt?: true; agentNever?: string };
type Page = { id: string; label: string };

/** Every .tsx file under web/src/components, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
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
  for (const m of text.matchAll(/<Section\s+title="([^"]*)"/g)) out.push({ at: m.index!, title: m[1]! });
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
    const hintMatch = after.match(/\bhint="([^"]{1,140})"/);
    // Which setting an agent reaches through this row, and the rows that are
    // not settings at all (a reset button, a read-out). Both are written BEFORE
    // `label=` in the tag, so they are found in the same text the tag name was:
    // from the tag's opening to the label, nothing past it to mistake for the
    // next row's.
    const tagText = before.slice(tagMatch.index!);
    const settingId = tagText.match(/\bsettingId="([^"]{1,80})"/)?.[1];
    const agentExempt = /\bagentExempt\b/.test(tagText);
    // A row an agent must not reach, with the reason on the row itself.
    const agentNever = tagText.match(/\bagentNever="([^"]{1,240})"/)?.[1];
    rows.push({
      pane, section: sectionFor(markers, m.index!), label, hint: hintMatch ? hintMatch[1]! : "",
      ...(settingId ? { settingId } : {}), ...(agentExempt ? { agentExempt: true as const } : {}), ...(agentNever ? { agentNever } : {}),
    });
  }
  return rows;
}

/** Capitalised JSX tags in a slice of source that name a component this repo
 *  defines under web/src/components, minus the small set of primitives that
 *  are not pages of their own (they are how a ROW draws, not what a pane is
 *  made of). */
const SKIP_TAGS = new Set(["SettingRow", "Row", "Toggle", "Fold", "Select", "Switch", "Section", "Fragment"]);
function subComponentsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)) {
    const name = m[1]!;
    if (!SKIP_TAGS.has(name)) found.add(name);
  }
  return [...found];
}

function rowsForPane(pane: string, block: string, seenComponents: Set<string>): Row[] {
  const rows = rowsIn(block, pane);
  for (const comp of subComponentsIn(block)) {
    if (seenComponents.has(`${pane}:${comp}`)) continue;
    seenComponents.add(`${pane}:${comp}`);
    const file = fileDefining(comp);
    if (!file) continue; // not a component this repo defines (an icon, a DOM-ish tag, etc.)
    const body = componentBody(file, comp);
    if (!body) continue;
    rows.push(...rowsIn(body, pane));
  }
  return rows;
}

/** Builds the generated file's text without writing it — the part
 *  settings-index-rows.test.ts calls directly to check the committed file is
 *  fresh, without shelling out to a second bun process. */
export function buildOutput(): string {
  const modalSrc = textOf(MODAL_PATH);

  const pages: Page[] = [];
  const tabRe = /\{ id: "([a-z-]+)"(?: as const)?, label: "([^"]*)", group: "[^"]*"(?: as const)?, kw: "([^"]*)"/g;
  for (const m of modalSrc.matchAll(tabRe)) pages.push({ id: m[1]!, label: m[2]! });

  const blockMarks = [...modalSrc.matchAll(/\{show\("([a-z-]+)"\) &&/g)];
  const seenComponents = new Set<string>();
  const rows: Row[] = [];
  for (let i = 0; i < blockMarks.length; i++) {
    const m = blockMarks[i]!;
    const pane = m[1]!;
    const body = modalSrc.slice(m.index!, i + 1 < blockMarks.length ? blockMarks[i + 1]!.index! : modalSrc.length);
    rows.push(...rowsForPane(pane, body, seenComponents));
  }

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
