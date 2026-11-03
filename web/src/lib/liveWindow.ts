// "Is Claude already working in the window this button would open?"
//
// Asked of the engine, never remembered by the component: a card that kept it
// in state would forget on a reload and know nothing of a second window of the
// app. No timer. It is read when a card appears, when the window gets focus
// back, and whenever the Terminal's tab strip reports a change, which is the
// moment a window opens or closes.
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api.ts";
import { requestWorktreeJump } from "./worktreeJump.ts";

export type LiveWindow = { session: string; windowId: string; paneId: string; name: string; path: string;
  /** The agent in it has ended its turn: the window is open, nobody is editing. */
  idle?: true };

let tick = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<() => void>();

/** The tab strip changed (a window opened, closed or was renamed): every card
 *  asks again, once, after the burst settles. */
export function noteWindowsChanged(): void {
  if (!subs.size || timer) return;
  timer = setTimeout(() => { timer = null; tick++; subs.forEach((f) => f()); }, 300);
}

/** Fed with every tab-strip frame; speaks only when the SET of windows changed,
 *  because a frame also goes out for a status change and that is no reason to
 *  ask again. */
let lastSet = "";
export function noteWindowSet(windows: { id: string; name: string; status?: string }[]): void {
  // The agent's status is part of it: an agent that stops working releases the
  // lock without its window closing, and a status frame is the only event there is.
  const key = windows.map((w) => `${w.id}:${w.name}:${w.status ?? ""}`).join("|");
  if (key === lastSet) return;
  lastSet = key;
  noteWindowsChanged();
}

/** Ask to be told, once per burst, when the set of windows or a window's status
 *  changed, and when the app regains focus. */
export function subscribe(fn: () => void): () => void {
  if (!subs.size && typeof window !== "undefined") {
    window.addEventListener("focus", noteWindowsChanged);
    document.addEventListener("visibilitychange", noteWindowsChanged);
  }
  subs.add(fn);
  return () => {
    subs.delete(fn);
    if (!subs.size && typeof window !== "undefined") {
      window.removeEventListener("focus", noteWindowsChanged);
      document.removeEventListener("visibilitychange", noteWindowsChanged);
    }
  };
}

/** The live window named `name` in the repository of `root` (and in the
 *  checkout `path`, when given), or null. A failed read keeps the last answer:
 *  a server that did not reply is not a window that closed. */
export function useLiveWindow(root: string, name: string, path?: string): LiveWindow | null {
  const [w, setW] = useState<LiveWindow | null>(null);
  const t = useSyncExternalStore(subscribe, () => tick, () => 0);
  useEffect(() => {
    if (!root || !name) { setW(null); return; }
    let stale = false;
    api.tmuxLiveWindow(root, name, path)
      .then((r) => { if (!stale && r.ok) setW(r.window ?? null); })
      .catch(() => { /* keep what it was */ });
    return () => { stale = true; };
  }, [root, name, path, t]);
  // Another card's answer must never show on this one while its own is out.
  return w && w.name === name ? w : null;
}

/** Bring that window to the front and show the Terminal. The window is in the
 *  session the button opened it in, which is the one the strip is showing. */
export async function openLiveWindow(w: LiveWindow): Promise<void> {
  await api.tmuxWindowOp("select-window", { session: w.session, windowId: w.windowId }).catch(() => undefined);
  requestWorktreeJump({ view: "term" });
}

/** After a handoff the terminal answered: take the person to the agent's tab,
 *  whether it was just started or was already there. A refusal stays where it
 *  is, so the error is read next to the button. No window found (the strip has
 *  not caught up) still brings the Terminal forward. */
export async function followHandoff(
  done: { ok: boolean }, find: () => Promise<LiveWindow | null>,
  open: (w: LiveWindow) => Promise<void> = openLiveWindow,
  jump: () => void = () => requestWorktreeJump({ view: "term" }),
): Promise<void> {
  if (!done.ok) return;
  const w = await find().catch(() => null);
  if (w) await open(w); else jump();
}
