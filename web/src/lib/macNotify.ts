import { actionTarget, primaryAction, secondaryAction, type NotifyPayload } from "../../../shared/notifyPayload.ts";
import { bridgeNotify, bridgePlatform } from "./desktop.ts";
import { gotoOfTarget } from "./notifyRoute.ts";
import type { SystemNote } from "./sysNotify.ts";

/**
 * Action buttons on a macOS notification.
 *
 * The renderer's Notification cannot carry them there; the shell's main
 * process can (electron/notify-mac.js). UNTESTED ON A REAL MAC: nothing here
 * has drawn a button, it is written against Electron's documented API.
 *
 * Ceiling: a button is a TRIP, never a deed. Each entry carries the same
 * in-app destination a click already goes to, so a press does exactly what
 * the renderer's own popup does and nothing looser. An action that writes
 * (`run`) has no entry, and neither has a `url`, which the click never opened.
 */
export type PopupEntry = { label: string; dest: NonNullable<SystemNote["goto"]> };

/** The buttons a payload may show, primary first (the notification body is the primary too). Empty means "use the renderer's popup". */
export function popupEntries(p: NotifyPayload): PopupEntry[] {
  const first = primaryAction(p);
  const t = first ? actionTarget(first) : null;
  const dest = t ? gotoOfTarget(t) : null;
  // A primary that is not a trip leaves nothing to press: the second must never become what a click does.
  if (!first || !dest) return [];
  const out: PopupEntry[] = [{ label: first.label, dest }];
  const second = secondaryAction(p);
  const st = second ? actionTarget(second) : null;
  const sd = st ? gotoOfTarget(st) : null;
  if (second && sd) out.push({ label: second.label, dest: sd });
  return out;
}

/** Which half raises the popup. Linux and Windows never leave the renderer. */
export const popupPath = (platform: string | undefined, hasShellNotify: boolean, entries: number): "shell" | "renderer" =>
  platform === "darwin" && hasShellNotify && entries > 0 ? "shell" : "renderer";

/** Decided on the spot, so every other platform raises its popup in the same tick it always did. */
export const canRaiseInShell = (entries: number): boolean => popupPath(bridgePlatform(), !!bridgeNotify(), entries) === "shell";

const waiting = new Map<string, (index: number) => void>();
let listening = false;
let seq = 0;

/**
 * Raise it from the shell. Resolves true when the shell took it (the press
 * will call `onPress` with the entry's index), false when the caller should
 * raise the renderer's own popup instead.
 */
export async function raiseInShell(
  a: { title: string; body: string; urgent: boolean; tag?: string; closeAfterMs: number },
  entries: PopupEntry[],
  onPress: (entry: PopupEntry) => void,
): Promise<boolean> {
  const b = bridgeNotify();
  if (!b || !canRaiseInShell(entries.length)) return false;
  if (!listening) {
    listening = true;
    b.onPress(({ tag, index }) => { waiting.get(tag)?.(index); });
  }
  const tag = a.tag ?? `mac-${++seq}`;
  waiting.set(tag, (i) => { waiting.delete(tag); const e = entries[i]; if (e) onPress(e); });
  try {
    const r = await b.notify({ title: a.title, body: a.body, urgent: a.urgent, tag, labels: entries.map((e) => e.label), closeAfterMs: a.closeAfterMs });
    if (r?.ok) return true;
  } catch { /* the renderer's popup is the fallback */ }
  waiting.delete(tag);
  return false;
}
