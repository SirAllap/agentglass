/**
 * What an agent's click does when it lands on a file input.
 *
 * Chromium answers a click on `<input type=file>` by opening the OS file
 * chooser on the PERSON's screen, which an agent's action must never do. For
 * the length of an agent click the driver turns on
 * `Page.setInterceptFileChooserDialog`; Chromium then sends
 * `Page.fileChooserOpened` instead of a dialog, and this turns those events
 * into a sentence for the answer that names the verb that fills it: `upload`.
 *
 * Scope, and its limit: interception is per debugger session, and cannot tell
 * who clicked. So it is on only around an agent's `click` and off again
 * afterwards. A person clicking a file input in the same tab within that
 * window (the click plus its settle, about a second) would get nothing; every
 * other time they get their dialog. Other acting verbs (`press` on a focused
 * input, `dblclick`) are not covered yet.
 */
export type ChooserNote = { mode: "selectSingle" | "selectMultiple"; backendNodeId?: number; note: string };

export function fileChooserNote(
  events: ReadonlyArray<{ method: string; params?: unknown }>,
  selector: string,
): ChooserNote | null {
  let hit: { mode?: unknown; backendNodeId?: unknown } | undefined;
  for (const e of events) if (e.method === "Page.fileChooserOpened") hit = (e.params ?? {}) as { mode?: unknown; backendNodeId?: unknown };
  if (!hit) return null;
  const mode = hit.mode === "selectMultiple" ? "selectMultiple" : "selectSingle";
  const backendNodeId = typeof hit.backendNodeId === "number" ? hit.backendNodeId : undefined;
  return {
    mode,
    backendNodeId,
    note: `the click asked for a file chooser (${mode === "selectMultiple" ? "several files" : "one file"}); `
      + `no dialog was shown. Fill it with: upload ${selector} <absolute path>`,
  };
}
