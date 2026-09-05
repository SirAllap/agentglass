/*
 * "ASK ABOUT THE FIELD" — the Lantern's chat, as a tab on the floating bench.
 *
 * Herdr's Lantern is a chat in a pane. Here it is an agent tab on the bench:
 * reachable from any view with the bench's own chord, floating over the
 * Lantern itself so the board and the conversation are on screen together,
 * and a tmux session underneath, so closing the window does not end it. The
 * Chat view was the first answer and the wrong one — it was hidden from his
 * rail, and every agent he has lives in a pane already.
 *
 * The server composes the first message (the field as it is now) and mints
 * the ticket; nothing about what runs travels from here. This only picks the
 * slot and opens the window. One Lantern tab per checkout: asking again
 * brings the one that is there to the front rather than seating a second
 * agent beside it — the same rule Lantern's own `open` follows.
 */
import { api } from "./api.ts";
import { activateTab, addTab, benchState, closeTab, openBench, setBenchRoot, tabsFor, READER_SLOT, freeSlot } from "./benchStore.ts";

export const LANTERN_TAB_TITLE = "lantern";
/** The one bench tab whose close ENDS what it runs: the observer must not
 *  outlive the window it was opened in, or it shows up on its own board. */
export const isLanternTab = (t: { kind?: string; title?: string }): boolean => t.kind === "agent" && t.title === LANTERN_TAB_TITLE;

/** A slot with no session on it, on the engine as well as in the tab list —
 *  the bench attaches with `-A`, and a leftover shell on a reused slot would
 *  be reattached instead of the agent starting. Same rule FloatingBench keeps
 *  for its own menu. */
async function coldSlot(root: string): Promise<number> {
  const used = new Set(tabsFor(root).filter((t) => t.slot > 0).map((t) => t.slot));
  try {
    const r = await api.benchLive(root);
    if (r.ok) for (const n of r.slots) used.add(n);
  } catch { /* tmux could not be asked; the tab list is still a floor */ }
  used.add(READER_SLOT);
  for (let n = 1; n <= 99; n++) if (!used.has(n)) return n;
  return freeSlot(root);
}

/** Whether the bench holds the Lantern's tab at all — the view's label. */
export const hasLanternTab = (): boolean => Object.values(benchState().byRoot).some((h) => h.tabs.some(isLanternTab));

/** The Lantern's tab, wherever the bench holds it, and whether the session
 *  behind it is still on the engine. A tab whose session died — the chat
 *  was ended, the engine restarted — is a tab that would reattach as an
 *  empty shell called "lantern"; it is forgotten, and a fresh chat opens. */
async function lanternTabAlive(): Promise<{ root: string; id: string } | null> {
  for (const [root, held] of Object.entries(benchState().byRoot)) {
    const t = held.tabs.find(isLanternTab);
    if (!t) continue;
    let live = false;
    try { const r = await api.benchLive(root); live = r.ok && r.slots.includes(t.slot); } catch { /* tmux could not be asked: treat as dead */ }
    if (live) return { root, id: t.id };
    closeTab(root, t.id);
  }
  return null;
}

/**
 * A chat on the bench that opens with a message of yours — for a selection in
 * a pane that has no agent to ask. The prompt goes through the same ticket the
 * "start an agent" menu uses (POST /terminal/agent), never through the
 * terminal socket by text.
 */
export async function askOnBench(cwd: string, prompt: string, title = "ask"): Promise<{ ok: boolean; error?: string }> {
  const r = await api.termAgentTicket(cwd, prompt, false, title).catch((e) => ({ ok: false, error: String(e) } as { ok: boolean; ticket?: string; error?: string }));
  if (!r.ok || !r.ticket) return { ok: false, error: r.error ?? "could not start a chat" };
  setBenchRoot(cwd);
  const slot = await coldSlot(cwd);
  addTab(cwd, { kind: "agent", slot, title, agent: r.ticket });
  openBench();
  return { ok: true };
}

/** Hand a session's conversation to another agent on the bench. */
export async function handOff(session: string, kind: string): Promise<{ ok: boolean; error?: string }> {
  const r = await api.agentHandoff(session, kind).catch((e) => ({ ok: false, error: String(e) } as { ok: boolean; ticket?: string; cwd?: string; title?: string; error?: string }));
  if (!r.ok || !r.ticket || !r.cwd) return { ok: false, error: r.error ?? "could not hand off" };
  setBenchRoot(r.cwd);
  const slot = await coldSlot(r.cwd);
  addTab(r.cwd, { kind: "agent", slot, title: (r.title ?? "handoff").slice(0, 24), agent: r.ticket });
  openBench();
  return { ok: true };
}

export async function askLantern(): Promise<{ ok: boolean; error?: string }> {
  /* Reuse before minting: a ticket is single-use and short-lived, and one
     minted for a tab that is then merely brought to the front is wasted. */
  const there = await lanternTabAlive();
  if (there) {
    setBenchRoot(there.root);
    activateTab(there.root, there.id);
    openBench();
    return { ok: true };
  }
  const r = await api.lanternTicket().catch((e) => ({ ok: false, error: String(e) } as { ok: boolean; ticket?: string; cwd?: string; error?: string }));
  if (!r.ok || !r.ticket || !r.cwd) return { ok: false, error: r.error ?? "could not start the Lantern's chat" };
  const root = r.cwd;
  setBenchRoot(root);
  const slot = await coldSlot(root);
  addTab(root, { kind: "agent", slot, title: LANTERN_TAB_TITLE, agent: r.ticket });
  openBench();
  return { ok: true };
}
