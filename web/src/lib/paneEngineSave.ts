/*
 * A Pane engine control that saves its own value when it changes.
 *
 * The Restore switch and Resume mode used to ride along with the tmux binary
 * row's Save button, so a toggle that was never followed by that button was
 * lost on reload — and a tmux layout that restores after a power-off is the
 * point of the switch. The server already takes each field on its own
 * (`/terminal/tmux-settings` writes only what it was sent), so a control sends
 * just its own field.
 *
 * Returns what to show: `ok` keeps the new value, otherwise the caller puts the
 * old one back and shows `error`. A rejected request (server unreachable) is a
 * failed save like any other; it never leaves the control claiming a value the
 * server does not hold.
 */
export type PaneSave = (f: { restore?: boolean; resume?: string }) =>
  Promise<{ ok: boolean; error?: string }>;

export async function savePaneField(
  save: PaneSave,
  field: { restore: boolean } | { resume: "lazy" | "all" },
  what: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await save(field);
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? `Could not save ${what}.` };
  } catch {
    return { ok: false, error: `Could not save ${what} — server unreachable.` };
  }
}
