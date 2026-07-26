// Making a captured tmux pane readable inside a chat.
//
// `capture-pane` hands back the whole terminal: the height it was given, blank
// padding rows, and full-width box rules drawn to the pane's 200 columns. Shown
// raw, a six-line question arrived as a mostly-empty slab with a horizontal
// scrollbar — which is what it looked like when this was first shipped.
//
// So the frame is trimmed to the part that is actually the question. Nothing is
// reworded or reordered: this is the CLI's own drawing, and rewriting what a
// prompt says would be a good way to have someone confirm something else.

/** A rule the TUI draws to fill the width — `────`, `▔▔▔▔`, `━━━`. Long runs
 *  only, so an em-dash inside a sentence survives. */
const RULE = /^[\s]*[─━▁▔═_-]{12,}[\s]*$/;

/** The key hints a picker prints at the bottom. Dropped from the body because
 *  the UI shows them as real keys you can press — repeating them as text is the
 *  same instruction twice, in the less useful form. */
const HINTS = /^[\s]*(←\/→|↑\/↓|[←→↑↓\s\/]*)?\s*to (adjust|move|select|navigate)\b.*$|^[\s]*(Enter|Esc|Tab)\b.*(confirm|cancel|select|set as default|session only).*$/i;

/**
 * The readable part of a captured pane.
 *
 * Blank padding goes, rules go, hint lines go, and runs of blank lines collapse
 * to one. Trailing whitespace goes too — every captured row is padded to the
 * pane width, which is what produced the horizontal scrollbar.
 *
 * `max` caps how much is kept, counting from the END: a picker is drawn at the
 * bottom of the screen, and the interesting rows are the last ones, not the
 * banner from when the session started.
 */
export function tidyPaneScreen(screen: string, max = 14): string {
  const rows = screen
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => !RULE.test(l) && !HINTS.test(l));

  const out: string[] = [];
  for (const row of rows) {
    // Collapse runs of blank lines rather than dropping them all: the gap
    // between a heading and its options is part of how a picker reads.
    if (!row.trim() && !out[out.length - 1]?.trim()) continue;
    out.push(row);
  }
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();

  const kept = out.slice(-max);
  // Say when something was cut, rather than silently showing a fragment of a
  // question someone is about to answer.
  if (kept.length < out.length) kept.unshift(`… ${out.length - kept.length} earlier line${out.length - kept.length === 1 ? "" : "s"}`);

  // Every row is indented by the same amount when the TUI draws inside a box.
  // Removing that shared margin buys back real width on a narrow panel.
  const indents = kept.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length);
  const shared = indents.length ? Math.min(...indents) : 0;
  return kept.map((l) => l.slice(shared)).join("\n");
}

/** Is this frame still asking something?
 *
 *  Read from the frame rather than inferred from which key was pressed: Enter
 *  and Escape can both end a prompt, and some pickers stay open after Enter. */
export const paneStillAsking = (screen: string): boolean =>
  /Esc to cancel|Enter to confirm|to use this session only/.test(screen);
