/*
 * One text input, one house look.
 *
 * An audit found 125 `<input>` elements across `components/**`, each with its
 * own hand-mixed size, radius, fill and border. `INPUT` (`INPUT_STYLE`) in
 * `workspace/Chrome.tsx` is the one shape now: 32px, `rounded-lg`,
 * `--surface-inset`, `EDGE`. This asserts every text input either wears it or
 * is named on the short list below, with why.
 *
 * Source is read as text and matched against source, per this repo's rule for
 * a decision that belongs on the screen rather than at runtime: there is no
 * renderer here to mount the components and look.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../src/components", import.meta.url).pathname;

/** Every `.tsx` file under `src/components`, recursively. */
function componentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...componentFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Strips line and block comments, because a quoted example inside one is not
 *  a live input. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** One `<input ... />` tag's own text, from `<input` to its matching `/>` or
 *  `>`. Good enough for JSX that never nests a `<` inside an input's own
 *  attributes, which is true everywhere in this codebase. */
function inputTags(src: string): string[] {
  const out: string[] = [];
  const re = /<input\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index;
    const close = src.indexOf("/>", start);
    const nextOpen = src.indexOf("<", start + 6);
    const end = close >= 0 && (nextOpen < 0 || close < nextOpen) ? close + 2 : src.indexOf(">", start) + 1;
    out.push(src.slice(start, end));
  }
  return out;
}

const EXCLUDED_TYPE = /type=["']?(checkbox|radio|range|hidden|file)\b/;

/**
 * Inputs that keep their old, ad-hoc styling on purpose, one per line with
 * why. `marker` is a short, source-unique substring of the input's own tag
 * text (a value/placeholder/prop), not a line number, so the list survives
 * reformatting.
 */
const ALLOWED: { file: string; marker: string; why: string }[] = [
  { file: "FilesPanel.tsx", marker: 'placeholder={mode === "names" ? "Find a file by name…"',
    why: "icon and a clear button share the pill's one border with the input; moving it onto the input would put them outside it" },

  { file: "FilePalette.tsx", marker: "placeholder={active.placeholder}",
    why: "icon and a conditional PlaceChip share the pill's one border with the input" },

  { file: "TasksPanel.tsx", marker: "ref={searchBox} value={q}",
    why: "icon and a clear-button segment welded to the field's right edge share the pill's one border and clip radius with the input" },
  { file: "TasksPanel.tsx", marker: 'placeholder="8:30"',
    why: "compact time-entry field inside a narrow dropdown popover; INPUT's 32px height does not fit the row" },
  { file: "TasksPanel.tsx", marker: 'type="date" value={current} disabled={busy}',
    why: "compact inline date editor in a field-edit row, not a search box" },
  { file: "TasksPanel.tsx", marker: "onBlur={save}",
    why: "compact inline card-title editor with a dynamic width, not a search box" },
  { file: "TasksPanel.tsx", marker: "type=\"date\" value={msToDay(value)}",
    why: "compact inline date editor in a card row, not a search box" },
  { file: "TasksPanel.tsx", marker: 'placeholder={known.length ? "Filter or type a new one" : "tag"}',
    why: "compact inline tag-chip editor, not a search box" },
  { file: "TasksPanel.tsx", marker: 'value={skillQ}',
    why: "compact inline filter chip (10px, width 92) inside a card, not a search box" },
  { file: "TasksPanel.tsx", marker: "ref={barRef} value={input}",
    why: "icon and a ParseStrip share the pill's one border with the input" },
  { file: "TasksPanel.tsx", marker: 'autoFocus type="date" value={t.due',
    why: "compact inline due-date editor on a card, not a search box" },
  { file: "TasksPanel.tsx", marker: "autoFocus list=\"agx-projects\" value={projectText}",
    why: "compact inline project editor on a card, not a search box" },
  { file: "TasksPanel.tsx", marker: 'autoFocus list="agx-tags" value={tagText}',
    why: "compact inline tag editor on a card, not a search box" },
  { file: "TasksPanel.tsx", marker: 'placeholder="Search the workspace"',
    why: "icon and a CloseButton share the header row's one border with the input" },

  { file: "BrowserPanel.tsx", marker: "value={renaming.name}",
    why: "inline rename of a folder in a 20px tree row; INPUT's 32px height and fill would break the row" },
  { file: "ChatPanel.tsx", marker: "onBlur={commit}",
    why: "inline rename of a chat's title, typed over the title text itself; INPUT's 32px height would break the row" },
  { file: "BrowserPanel.tsx", marker: 'data-agx-omni="1"',
    why: "the omnibox and its suggestion list share the popover's one border" },

  { file: "PrPanel.tsx", marker: 'placeholder="Filter files…"',
    why: "icon and a clear button share the pill's one border with the input" },

  { file: "FilterPresets.tsx", marker: 'aria-label="Preset name"',
    why: "a preset's name edited in place, inside the chip itself or a menu row; INPUT's 32px height would not fit either" },
  { file: "TerminalPanel.tsx", marker: "defaultValue={String(w.index)}",
    why: "a 7-character-wide inline rename of a window's position in the tab strip; not a search box" },
  { file: "TerminalPanel.tsx", marker: "defaultValue={w.name}",
    why: "inline rename of a window in the tab strip; INPUT's 32px height would break the strip" },

  { file: "plugins/PluginTree.tsx", marker: 'className="agx-input" style={inputStyle} type="text"',
    why: "one of a generative-plugin field's input/textarea/select triad sharing `.agx-input`; converting only the input would split the triad's look back apart" },
  { file: "plugins/PluginTree.tsx", marker: 'className="agx-input" style={style} type="text" inputMode="decimal"',
    why: "same `.agx-input` triad as the field above" },
  { file: "plugins/PluginTree.tsx", marker: 'className="agx-input" style={style} type="password"',
    why: "same `.agx-input` triad as the text field above; a masked key box that looks like the field it replaces" },
  { file: "plugins/PluginTree.tsx", marker: 'className="agx-input t-mono w-full"',
    why: "same `.agx-input` family; a borderless search row inside a popover list" },

  { file: "understudy/Ask.tsx", marker: 'className="agx-input flex-1 min-w-0"',
    why: "shares `.agx-input` with this screen's other fields" },
  { file: "understudy/Work.tsx", marker: "ref={taskBox}",
    why: "fused to the select beside it into one segmented control (shared corner radii, no gap); not a standalone input" },
  { file: "understudy/Work.tsx", marker: 'className="agx-input flex-1 min-w-[220px]"',
    why: "shares `.agx-input` with this screen's other fields" },
];

function isAllowed(file: string, tag: string): string | undefined {
  const hit = ALLOWED.find((a) => file.endsWith(a.file) && tag.includes(a.marker));
  return hit?.why;
}

const files = componentFiles(ROOT);
const sources = new Map(await Promise.all(files.map(async (f) => [f, await Bun.file(f).text()] as const)));

describe("text inputs wear the house INPUT token", () => {
  it("every non-checkbox <input> uses INPUT, or is on the short allowlist", () => {
    const offenders: string[] = [];
    for (const [f, raw] of sources) {
      const src = stripComments(raw);
      for (const tag of inputTags(src)) {
        if (EXCLUDED_TYPE.test(tag)) continue;
        if (tag.includes("INPUT")) continue;
        if (isAllowed(f, tag)) continue;
        offenders.push(`${f}: ${tag.slice(0, 80).replace(/\s+/g, " ")}…`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every allowlist entry still matches a real input (or it is dead weight)", () => {
    for (const a of ALLOWED) {
      const hit = [...sources.entries()].find(([f, raw]) => f.endsWith(a.file) && stripComments(raw).includes(a.marker));
      expect(hit, `${a.file}: ${a.marker}`).toBeDefined();
    }
  });
});
