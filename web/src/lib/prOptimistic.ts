/*
 * The cheap, reversible writes on a pull request, drawn on the press.
 *
 * An emoji, a ticked box in the description, a resolved thread and a label used
 * to go through the same path as a merge: grey the buttons, wait for GitHub,
 * then re-read the pull request AND the list before the screen changed. Measured
 * on the reaction button, the emoji stayed unpressed behind "Reaction — done ·
 * Loading pull requests…" for as long as that list took, which is the slowest
 * read in the panel. Nothing about an emoji needs a confirmation that expensive:
 * it is one call, it undoes with the same call, and GitHub is not going to
 * refuse it for any reason worth making the reader wait for.
 *
 * So the change is drawn as a layer over the pull request the server last
 * returned, and the write goes out behind it. The layer is the whole trick, and
 * the reason this is a file:
 *
 *   - A failure takes the layer away, which is the rollback. There is no
 *     "previous value" to remember and put back, so two presses in flight can
 *     not restore each other's stale snapshot.
 *   - A read that was ALREADY in flight when the write went out answers with the
 *     pull request as it was before the write. Replacing the screen with it
 *     would flip the emoji back for a second, and then forward again on the next
 *     read. The layer outlives any read that began before its write finished.
 *   - A read that began AFTER the write finished is GitHub's own answer, and it
 *     wins: the layer drops and the server's value is shown.
 *
 * Patches must SET rather than toggle — "this box is ticked", never "flip this
 * box" — because a layer can end up drawn over a pull request that already has
 * the change in it, and setting twice is harmless where flipping twice is not.
 *
 * Deliberately not here: merge, close, a comment, a review, anything that also
 * moves a card on another board. Those have consequences a rollback cannot take
 * back, and they still wait for the answer.
 */

import type { PrDetail, PrReaction } from "../../../shared/types.ts";

export type Sent = { ok: boolean; error?: string };

export interface OptimisticHost {
  /** The layer changed — redraw. */
  onChange: () => void;
  /** A write did not land and its layer is gone: say so, once. */
  onFail: (text: string) => void;
}

interface Layer<T> {
  patch: (t: T) => T;
  /** The clock value when the write answered yes; undefined while it is out. */
  settledAt?: number;
}

export class Optimistic<T> {
  /** One counter for both reads and settlements, so "which came first" is a
   *  comparison of two numbers rather than of two timestamps that can tie. */
  private clock = 0;
  private layers: Layer<T>[] = [];
  /** Writes that share a lane go out in order: two ticks of the description
   *  each send the whole body, and the second must not land first. */
  private lanes = new Map<string, Promise<unknown>>();

  constructor(private host: OptimisticHost) {}

  /** The server's value with every standing layer drawn over it, oldest first. */
  view(base: T): T {
    return this.layers.reduce((t, l) => l.patch(t), base);
  }

  /** How many layers are standing. Tests, and nothing else. */
  get size(): number { return this.layers.length; }

  /** A read is about to go out. Hand the ticket back to `readLanded`. */
  readStarted(): number { return ++this.clock; }

  /**
   * The read with this ticket has answered and is about to replace the base.
   *
   * Only a layer whose write had ALREADY answered yes when the read began can
   * go: that read saw the change. A write still out, or one that finished after
   * the read went, is not in what the read returned. A `stale` answer — the
   * server handing back what it had cached — confirms nothing either.
   */
  readLanded(ticket: number, opts: { stale?: boolean } = {}): void {
    if (opts.stale) return;
    const before = this.layers.length;
    this.layers = this.layers.filter((l) => l.settledAt === undefined || l.settledAt >= ticket);
    if (this.layers.length !== before) this.host.onChange();
  }

  /**
   * Draw `patch` now, send, and keep it or take it back.
   *
   * Resolves to whether the write landed; nothing in the UI waits on it.
   */
  run(w: { patch: (t: T) => T; send: () => Promise<Sent>; failText: string; lane?: string }): Promise<boolean> {
    const layer: Layer<T> = { patch: w.patch };
    this.layers.push(layer);
    this.host.onChange();

    const go = async (): Promise<boolean> => {
      let r: Sent;
      try { r = await w.send(); }
      catch (e) { r = { ok: false, error: String((e as Error)?.message || e) }; }
      if (r.ok) {
        layer.settledAt = ++this.clock;
        return true;
      }
      this.layers = this.layers.filter((l) => l !== layer);
      this.host.onChange();
      this.host.onFail(r.error ? `${w.failText}: ${r.error}` : w.failText);
      return false;
    };

    if (!w.lane) return go();
    const mine = (this.lanes.get(w.lane) ?? Promise.resolve()).then(go);
    this.lanes.set(w.lane, mine.catch(() => {}));
    return mine;
  }
}

/* ------------------------------------------------------------------ patches */

/** One tally set to `on` for the viewer. Absent and on adds it; a count that
 *  reaches nothing drops out, as GitHub's own list does. */
function setReaction(list: PrReaction[] | undefined, content: string, on: boolean): PrReaction[] {
  const cur = list ?? [];
  const hit = cur.find((r) => r.content === content);
  if (!hit) return on ? [...cur, { content, count: 1, viewerHasReacted: true }] : cur;
  if (hit.viewerHasReacted === on) return cur;
  const count = hit.count + (on ? 1 : -1);
  return count > 0
    ? cur.map((r) => (r === hit ? { ...r, count, viewerHasReacted: on } : r))
    : cur.filter((r) => r !== hit);
}

/** Your emoji on whatever carries this node id: the body, a comment, a review
 *  or a line comment. Ids are GitHub's, unique across all of them. */
export const reactionPatch = (nodeId: string, content: string, on: boolean) => (d: PrDetail): PrDetail => ({
  ...d,
  bodyReactions: d.nodeId === nodeId ? setReaction(d.bodyReactions, content, on) : d.bodyReactions,
  comments: d.comments.map((c) => (c.nodeId === nodeId ? { ...c, reactions: setReaction(c.reactions, content, on) } : c)),
  reviews: d.reviews.map((r) => (r.nodeId === nodeId ? { ...r, reactions: setReaction(r.reactions, content, on) } : r)),
  threads: d.threads.map((t) => (t.comments.some((c) => c.id === nodeId)
    ? { ...t, comments: t.comments.map((c) => (c.id === nodeId ? { ...c, reactions: setReaction(c.reactions, content, on) } : c)) }
    : t)),
});

/** The description as it will be after the tick. The whole body is what the
 *  write sends, so the whole body is what is drawn; the checklist beside it is
 *  read from the same text so the merge signal moves with the box. */
export const bodyPatch = (number: number, body: string, checklist: PrDetail["checklist"]) => (d: PrDetail): PrDetail =>
  d.number === number ? { ...d, body, checklist } : d;

export const resolvedPatch = (threadId: string, resolved: boolean) => (d: PrDetail): PrDetail => ({
  ...d,
  threads: d.threads.map((t) => (t.id === threadId ? { ...t, isResolved: resolved } : t)),
});

/** Labels on and off by name. A label added here keeps the colour the picker
 *  showed it in, when it knows one. */
export const labelsPatch = (number: number, add: string[], remove: string[], colors: Record<string, string> = {}) =>
  (d: PrDetail): PrDetail => {
    if (d.number !== number) return d;
    const kept = d.labels.filter((l) => !remove.includes(l.name));
    const fresh = add.filter((n) => !kept.some((l) => l.name === n))
      .map((name) => (colors[name] ? { name, color: colors[name] } : { name }));
    return { ...d, labels: [...kept, ...fresh] };
  };

/* The sidebar's other fields, drawn the same way. Each one SETS: the assignee
   list after the edit is what the layer says, never "toggle this login". */

const names = (list: string[], add: string[], remove: string[]) =>
  [...list.filter((x) => !remove.includes(x)), ...add.filter((x) => !list.includes(x))];

export const assigneesPatch = (number: number, add: string[], remove: string[]) => (d: PrDetail): PrDetail =>
  d.number === number ? { ...d, assignees: names(d.assignees, add, remove) } : d;

export const reviewersPatch = (number: number, add: string[], remove: string[]) => (d: PrDetail): PrDetail => {
  if (d.number !== number) return d;
  const kept = d.reviewers.filter((r) => !remove.includes(r.login));
  return { ...d, reviewers: [...kept, ...add.filter((l) => !kept.some((r) => r.login === l)).map((login) => ({ login }))] };
};

export const milestonePatch = (number: number, title: string) => (d: PrDetail): PrDetail =>
  d.number === number ? { ...d, milestone: title || null } : d;

export const draftPatch = (number: number, isDraft: boolean) => (d: PrDetail): PrDetail =>
  d.number === number ? { ...d, isDraft } : d;

export const titlePatch = (number: number, title: string) => (d: PrDetail): PrDetail =>
  d.number === number ? { ...d, title } : d;
