/*
 * WHO OWNS THE TAB AN ASK IS ABOUT — the panel's rule, in one place both
 * sides can load.
 *
 * It lived in `web/src/lib/browserDrive.ts` (rightly: DOM code cannot be read
 * by a server test) but that still left the relay's own tests unable to apply
 * the rule, so a relay stub answered every verb from any tab and a `do` that
 * sent its second step to the person's tab passed. A stub that applies the
 * real rule is the only way such a test can go red.
 *
 * Nothing here touches a page or a window: inputs in, an answer out.
 */

/** What the panel (or a stub standing in for it) worked out about one ask. */
import { foldWorkerName } from "./workerContainer.ts";

export interface AskOwnership {
  /** The tab the panel resolved this ask to. */
  tab: string;
  /** That tab's container, under the name `tabs` reports — `default` said out
   *  loud, never an empty string, because "not set" and "the shared space
   *  everybody else is also in" are not the same answer. */
  container: string;
  /** Who is asking, or empty when the wire carried no identity. */
  as: string;
  /** The operator typed `--page`, or named this exact tab with `tab <id>`. */
  pageExplicit: boolean;
  /** The verb changes the page, as opposed to only reading it. */
  acts: boolean;
}

/**
 * Why this ask must not be served, or `null` to serve it.
 *
 * UNVERIFIABLE IS NOT A MISMATCH: an empty `as` means "cannot tell", and
 * cannot-tell is allowed — closing that hole is the CLI's job and the MCP
 * surface's, not this function's.
 */
export function crossContainerRefusal(o: AskOwnership): string | null {
  if (!o.as) return null;
  if (o.pageExplicit) return null;
  /* Both sides under the one fold: the panel passes the container owner
     (`containerOwner("agent:Alba")` → `alba`) and the raw `as` the caller
     typed, and a capitalised legal worker name was refused its own tab. */
  if (foldWorkerName(o.container) === foldWorkerName(o.as)) return null;
  const kind = o.acts ? "cross-container act refused" : "cross-container read refused";
  return `${kind}: tab ${o.tab} is in container "${o.container}" and you are "${o.as}" — `
    + "refused rather than acted on, because two agents in one tab is a page that changes "
    + "under somebody mid-task and neither of you sees it. "
    + `Open your own with \`open --as ${o.as} <url>\`, or say you meant this one with \`--page ${o.tab}\`.`;
}

/**
 * Which tab an ask is served from: the one it names, else the one in front.
 *
 * A named tab that is not in the window is a refusal, never a quiet fallback:
 * an agent that asked for its own page and was answered from somebody else's
 * cannot tell the difference from the answer.
 */
export function resolveAskTab(
  o: { page?: unknown; active: string | null; present: readonly string[] },
): { tab: string | null } | { error: string } {
  if (typeof o.page === "string" && o.page) {
    return o.present.includes(o.page)
      ? { tab: o.page }
      : { error: `no tab called ${o.page} — it was closed, it belongs to a window that is gone, `
        + "or the app restarted before that tab was saved. Call `tabs` to re-read them, "
        + "or open your own with `open --as <your name> <url>`." };
  }
  return { tab: o.active };
}

/**
 * Does a tab an ask just minted take the visible pane?
 *
 * Always did, which is why an agent's routine work moved what the person was
 * looking at. Two exceptions and no more: an empty window has to show the tab
 * it just made, and a caller that asked to be shown gets what it asked for.
 */
export function mintTakesThePane(o: { existing: number; show: boolean }): boolean {
  return o.show || o.existing === 0;
}
