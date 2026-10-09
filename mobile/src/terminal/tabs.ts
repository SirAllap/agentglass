/*
 * The tabs, shaped like the ones on the computer.
 *
 * `/terminal/panes` answers one row per PANE, and the phone drew that list
 * directly — so a window split in two appeared as two tabs with the same name,
 * and the strip did not look like the strip on the desk, which shows WINDOWS:
 *
 *     1 Orbit.AI   2 AI00   3 AI01   4 AI02   5 AI03   6 pr-8421
 *
 * So panes are grouped back into their windows here. A window with one pane is
 * one tab, named the way tmux names it — index first, because that is what the
 * prefix key addresses and what the desk shows. A window with more than one
 * becomes one tab per pane, suffixed `·p1`, `·p2`, so a split is still
 * reachable without inventing a second level of navigation on a phone.
 *
 * Pure, and separate from the screen, because "which tabs are there" is worth a
 * test and "what a tab looks like" is not.
 */

/*
 * The row is `AgentPane` from the contract, and it did not used to be.
 *
 * This file declared its own copy — eight fields plus `popup` and `attached` —
 * because the shared one described neither of the last two: they lived inline
 * in `listPanes`'s return type on the server, where nothing here could see
 * them. A private copy of a wire shape cannot be wrong about the wire, it can
 * only disagree with it silently, and `attached` is the field this strip
 * filters on. See the note on `AgentPane.attached`.
 */
import type { AgentPane, PanesResponse } from "../../../shared/types.ts";
import type { WindowStatus } from "../../../shared/windowStatus.ts";

export interface Tab {
  /** tmux's pane id — what the socket is opened with. */
  paneId: string;
  /** `1 Orbit.AI`, or `4 AI02·p2` when the window is split. */
  label: string;
  /** The session it belongs to, for the second line. */
  session: string;
  /** The pane's full directory: what Source control and Files take as a root. */
  where: string;
  /** An agent is running under this pane. The reason to open it. */
  agent: boolean;
  /** The window's own name, without tmux's index: what a tab on the strip says.
   *  Suffixed `·p2` where a split needs it, like `label`. */
  name: string;
  /** What the agent in it is doing, where the server said (absent: no agent). */
  status?: WindowStatus;
  /** The window's hand-set group (`@agx-group`); absent means "by project". */
  group?: string;
  /** Pinned first in its group (`@agx-pin`) — where the orchestrator sits. */
  pinned?: true;
  /** The project's main-checkout root; null in no repository, absent while the
   *  server is still finding out. */
  repo?: string | null;
  /** tmux's id for the window this pane is in (`@3`) — what rename and close
   *  address. Empty for a pane the strip has not listed yet, which has nothing
   *  to rename. */
  windowId: string;
  /** The window's own name exactly as tmux has it: no index, no `·pN`. What rename
   *  starts from and the close sentence quotes; `name` is the tab's, suffix and all. */
  windowName: string;
  /** How many panes the window has: closing a window closes all of them, and
   *  the confirmation says so. */
  windowPanes: number;
}

/**
 * Windows as tabs, splits as suffixed tabs.
 *
 * Ordered by session and then by window index NUMERICALLY — tmux's index is a
 * string, and sorting it as one puts window 10 between 1 and 2, which is
 * exactly the strip nobody can find anything in.
 */
/**
 * Sessions this app made, which are never a destination.
 *
 * Opening a tab creates a grouped session named `agx-phone-<pane>-<suffix>` so
 * the phone gets its own client without disturbing the desk (see
 * `attachArgvFor` on the server). Those sessions hold the SAME windows as the
 * one they were grouped with, so leaving them in put a duplicate of every tab
 * in the picker — one more each time a tab was opened.
 */
const OURS = /^agx-phone-/;

export function paneTabs(panes: readonly AgentPane[]): Tab[] {
  /*
   * Nothing else to show is the one case where a detached session on the
   * app's own server is worth a tab: a shell opened from the empty state has
   * no client and no agent, and after a relaunch it would be the only thing
   * there and be filtered like a stray. Asked second, so a machine with real
   * windows never lists the app's old detached sessions beside them. Ceiling:
   * a machine with only stale detached sessions on the app's server lists them.
   */
  const tabs = tabsOf(panes, false);
  return tabs.length ? tabs : tabsOf(panes, true);
}

function tabsOf(panes: readonly AgentPane[], keepOwnDetached: boolean): Tab[] {
  const windows = new Map<string, AgentPane[]>();
  for (const pane of panes) {
    if (OURS.test(pane.session)) continue;
    /*
     * A scratchpad is not a destination while nobody is in it, and is the
     * whole point while someone is: the popup is open on the desk and the phone
     * is the only way to read it.
     *
     * `attached` tells the two apart exactly: the scratch is `display-popup -E
     * "tmux attach -t scratch"`, so a client is on that session for as long as
     * the popup is up. `!== true` and not `=== false`: absent is a third answer
     * on this wire, and a build too old to say keeps the old behaviour.
     */
    if (pane.popup && pane.attached !== true) continue;
    /*
     * A session on somebody else's tmux server is not in this list.
     *
     * `listPanes` walks the socket directory and answers for every server that
     * has a client, so a tmux the test suite left running — or another agent's
     * — arrives beside the one you work in. On a desk that is a row you scroll
     * past; on a phone the strip IS the screen, and half of it pointed at
     * sessions nobody can use.
     *
     * Reproduced before it was fixed, on a rig with two isolated servers:
     *
     *     canAttach: true   panes: 2
     *       agx-probe-9f2  win 0 sh      pane %0  attached true   <- a test's
     *       work           win 0 editor  pane %0  attached true   <- the real one
     *
     * Nothing on that wire told them apart. Not `attached`, both true. Not the
     * pane id — ids are per SERVER and both were `%0`, which is also why
     * opening one is a coin flip between two servers. And not the name: three
     * servers on this machine each held a session called
     * `agentglass-understudy`, so a prefix test would have been a guess
     * dressed as a rule.
     *
     * The server knows, because it has the socket, and now says so in a
     * boolean that carries no path. `=== false` and not `!own`: absent is a
     * third answer — a server too old to say, or one that has never attached
     * anything and has no server of its own to compare against — and in that
     * case this keeps what it always kept.
     */
    if (pane.own === false) continue;
    /*
     * Detached sessions are left out, unless an agent is running in one.
     *
     * A tmux server accumulates them — a test that did not clean up, a worktree
     * from last week — and the desk's own terminal panel never shows them
     * either: it shows the session its client is attached to. The exception is
     * the one case where a session nobody is watching still matters, which is
     * an agent working in it.
     */
    if (pane.attached === false && !pane.agentCwds.length && !(keepOwnDetached && pane.own === true)) continue;
    /*
     * Keyed on the session's NAME and the window, not on the session's id.
     *
     * The ids are per SERVER, and this list is every server on the machine —
     * `listPanes` walks the socket directory. So two of them both answer to
     * `$0` and `@0`, and keying on that pair welded two unrelated windows into
     * one tab group: seen on the phone with an isolated test server running
     * beside another, a two-pane window and a four-pane window came back as one
     * six-pane window labelled `0 sh·p1` through `0 sh·p6`, half of whose
     * tabs pointed into the wrong server.
     *
     * The name is the part that does not collide. tmux will not let one server
     * hold two sessions called the same thing, and two servers that both have a
     * session called `qa` are indistinguishable on this screen whatever the key
     * is — nothing on the wire says which server a row came from, because the
     * socket is a filesystem path and stays on the server's side of it.
     */
    // The separator is a NUL, spelled rather than typed: it cannot occur in a
    // session name or a window id, so no pair of them can collide by
    // concatenating differently. Written literally it made git treat this
    // whole file as binary, which means no diff of it is reviewable.
    const key = `${pane.session}\u0000${pane.windowId}`;
    windows.set(key, [...(windows.get(key) ?? []), pane]);
  }

  const tabs: Tab[] = [];
  for (const group of windows.values()) {
    const first = group[0]!;
    const name = `${first.windowIndex} ${first.windowName}`.trim();
    group.forEach((pane, i) => {
      const suffix = group.length > 1 ? `·p${i + 1}` : "";
      tabs.push({
        paneId: pane.paneId,
        // The suffix appears only when it distinguishes something. A lone pane
        // labelled `·p1` reads as "there is a p2 somewhere", and there is not.
        label: `${name}${suffix}`,
        name: `${first.windowName.trim() || first.windowIndex}${suffix}`,
        ...(pane.status ? { status: pane.status } : {}),
        ...(pane.group ? { group: pane.group } : {}),
        ...(pane.pinned ? { pinned: true as const } : {}),
        ...(pane.repo !== undefined ? { repo: pane.repo } : {}),
        session: pane.session,
        // The whole directory. It used to be the last segment, which is what a
        // person calls a checkout, and Source control and Files sent that as
        // the root: a name is no directory, and both answered as if the
        // checkout were empty. The screens draw the leaf themselves.
        where: pane.path,
        agent: pane.agentCwds.length > 0,
        windowId: pane.windowId,
        windowName: pane.windowName,
        windowPanes: group.length,
      });
    });
  }

  return tabs.sort((a, b) => {
    if (a.session !== b.session) return a.session.localeCompare(b.session);
    const index = (label: string): number => Number.parseInt(label, 10) || 0;
    const byIndex = index(a.label) - index(b.label);
    return byIndex !== 0 ? byIndex : a.label.localeCompare(b.label);
  });
}

/** A pane this phone itself just asked the server to open, held until the
 *  poll lists it for real. See `pendingTab`. */
export interface PendingTab {
  paneId: string;
  session: string;
  where: string;
  label: string;
}

/**
 * The tab for a pane this phone itself just opened, before the next poll
 * lists it. `paneTabs` filters a session with no tmux client and no agent
 * under it, and a plain shell the server was just asked to create is exactly
 * that until something attaches: without this bridge the empty state's "Open a
 * shell in <name>" left the phone on "Nothing open" through repeated "Look
 * again", because only the attach makes `attached` true and only a tab makes
 * the WebSocket attach. Once the poll lists the pane for real, `paneTabs`
 * answers first and this is never consulted again for it.
 */
export function pendingTab(pending: PendingTab | null, active: string | null): Tab | null {
  if (!pending || !active || pending.paneId !== active) return null;
  return { paneId: pending.paneId, label: pending.label, name: pending.label, session: pending.session, where: pending.where, agent: false, windowId: "", windowName: "", windowPanes: 1 };
}

/** Either the strip moved, and here is the whole of it, or it did not and there
 *  is nothing for the screen to do. */
export type StripRead =
  | { changed: false }
  | { changed: true; tabs: Tab[]; stale: boolean; shape: string };

/**
 * Read an answer against the last one, and say whether anything MOVED.
 *
 * The screen re-reads `/terminal/panes` every couple of seconds and the answer
 * is a fresh array each time, so adopting it unconditionally is a re-render
 * twice a second for ever, and a strip that repaints eats the tap you were
 * making: React Native hands a Pressable's touch to a view the next commit
 * replaces, and the release lands on nothing. The desk's tmux sweep compares
 * `JSON.stringify([session, client, windows])` for the same reason; the phone
 * has no such frame, so it compares at this end.
 *
 * Compared on the WHOLE tab, not on the fields drawn today: `paneTabs` has
 * already thrown away the path, window id and grouped-session rows, so a `cd`
 * at the desk repaints nothing, and a tab that starts showing one more field
 * cannot go quietly stale. `canAttach` is in the shape because it draws the
 * stale-server line above the composer.
 *
 * `Partial<PanesResponse>`: the server can be older than the phone. A missing
 * `canAttach` is what `stale` is for, and `panes` is still checked with
 * `Array.isArray` rather than trusted.
 */
export function readStrip(previous: string | null, answer: Partial<PanesResponse>): StripRead {
  const list = Array.isArray(answer.panes) ? answer.panes : [];
  const tabs = paneTabs(list);
  const stale = answer.canAttach !== true;
  const shape = JSON.stringify([stale, tabs]);
  if (shape === previous) return { changed: false };
  return { changed: true, tabs, stale, shape };
}

/**
 * Which session to open on.
 *
 * Not the first one. The strip is sorted by name so that it stays put between
 * refreshes, and on a real machine that put a session with a single idle shell
 * ahead of the one with six windows and five agents in it — so the terminal
 * opened on `1 fish` and the answer to "where are my tabs" was "three taps to
 * the right, off the edge of the screen".
 *
 * So: wherever the work is. Most panes with an agent under them first, then
 * most windows, then the name — the last one only so that two equally busy
 * sessions do not swap places every time the list is re-read.
 */
export function bestSession(tabs: readonly Tab[]): string | null {
  if (!tabs.length) return null;
  const score = new Map<string, { agents: number; windows: number }>();
  for (const tab of tabs) {
    const at = score.get(tab.session) ?? { agents: 0, windows: 0 };
    score.set(tab.session, {
      agents: at.agents + (tab.agent ? 1 : 0),
      windows: at.windows + 1,
    });
  }
  return [...score.entries()].sort((a, b) =>
    b[1].agents - a[1].agents
    || b[1].windows - a[1].windows
    || a[0].localeCompare(b[0]),
  )[0]![0];
}
