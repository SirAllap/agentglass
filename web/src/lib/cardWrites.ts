// Changing a card the way ClickUp changes one: on the press, not on a confirmation.
//
// What this replaces is a strip across the top of the board — "Move this card · in
// development → code review. Your team sees this. It is not undoable from here.
// [Do it] [Cancel]" — in front of every single field write. On a morning of triage
// that is two presses and a read for something you already decided when you opened
// the menu, and it made the panel feel slower than the website it exists to save
// you from. Reported that way: "it is very annoying and slows me down… no
// confirmation buttons that make everything slower and less fluid".
//
// Removing the confirmation leaves two problems, and they are the reason this is a
// file rather than three lines in a click handler.
//
// ONE: the stamp. Every write carries the `date_updated` the card was read at, so
// ClickUp refuses one whose card has moved since — that guard is how somebody
// else's change never gets silently overwritten. But the FIRST write moves the
// stamp, so a second one sent from the same screen is refused *by us*, and the
// honest-sounding message is "somebody changed this card while you had it open"
// when the somebody was you, half a second ago. That has been measured here before
// (a picker that sent three writes with one stamp); the fix is that every write
// answers with the card as it now stands, so the next write knows the new stamp.
// Which only works if the writes to one card are ORDERED — hence a queue per card.
//
// TWO: what the screen says while a write is out. Nothing here blocks the panel:
// the field being written is the only thing that goes busy, so status can be
// saving while you take yourself off the assignees and put two other people on.
// Those queue behind it and each one carries the stamp the one before it returned.
//
// A card is never left showing a value that did not land: the row is replaced with
// the card the server answers with, and a refusal puts the old value back and says
// what happened.

import type { ProviderTask } from "../../../shared/providers.ts";

export interface WriteResult {
  ok: boolean;
  error?: string;
  /** Somebody really did change it underneath you. */
  conflict?: boolean;
  /** The card as it stands after the write. Its `updated` is the next stamp. */
  task?: ProviderTask;
}

export interface CardWrite {
  /** Which card. Writes to one card are serialised; different cards do not wait
   *  for each other. */
  id: string;
  /**
   * What is being changed, for the in-flight set the UI reads: `status`, or
   * `who:12345`. One key per control, so a spinner lands on the control that is
   * saving and nowhere else.
   */
  key: string;
  /** The stamp this row was read at. Used only until a write answers with a
   *  newer one — see the note above about the second write. */
  readAt?: number;
  /** Said in the strip when it lands. */
  done: string;
  go: (stamp?: number) => Promise<WriteResult>;
}

export interface CardWritesHost {
  /** The card as the server now has it. The board should show this. */
  onTask: (task: ProviderTask) => void;
  /** One line for the person: what landed, or what did not. */
  onNote: (note: { ok: boolean; text: string }) => void;
  /** Something changed about what is in flight — redraw. */
  onChange: () => void;
  /** A write did not land: undo whatever was drawn optimistically for this key. */
  onRollback?: (write: CardWrite) => void;
}

export class CardWrites {
  /** One promise chain per card, so the stamp can be handed forward. */
  private chains = new Map<string, Promise<void>>();
  /** The freshest stamp we have seen for a card, from the last write that landed. */
  private stamps = new Map<string, number>();
  /**
   * `${id}|${key}` for everything still out.
   *
   * A visible separator on purpose. The first version used a raw NUL, which is the
   * separator this codebase uses for machine-read keys — and a raw control
   * character in a source file hides its line from grep, which there is a suite
   * here to refuse. Neither half can contain a pipe: a card id is alphanumeric and
   * a key is a name chosen in this file's callers.
   */
  private out = new Set<string>();

  constructor(private host: CardWritesHost) {}

  /** Is this one control saving? */
  busy(id: string, key: string): boolean {
    return this.out.has(`${id}|${key}`);
  }

  /** Is anything on this card saving? */
  busyCard(id: string): boolean {
    const prefix = `${id}|`;
    for (const k of this.out) if (k.startsWith(prefix)) return true;
    return false;
  }

  /** How many writes are out, anywhere. Only used by tests and by the strip. */
  get pending(): number { return this.out.size; }

  /**
   * Send one, behind whatever else is going to the same card.
   *
   * Returns when this write has finished, so a caller can await it — nothing in
   * the UI does, and that is the point.
   */
  run(write: CardWrite): Promise<void> {
    const slot = `${write.id}|${write.key}`;
    this.out.add(slot);
    this.host.onChange();

    const before = this.chains.get(write.id) ?? Promise.resolve();
    const mine = before.then(async () => {
      try {
        /* The newest stamp we know: the one the last write answered with, or the
           one this row was read at if this is the first. */
        const stamp = this.stamps.get(write.id) ?? write.readAt;
        const r = await write.go(stamp);
        if (r.ok) {
          if (r.task) {
            this.stamps.set(write.id, r.task.updated);
            this.host.onTask(r.task);
          } else {
            /* No card came back — an older server, or a route that does not
               answer with one. The stamp we hold is now wrong rather than stale,
               and a wrong stamp refuses every later write with somebody else's
               name on it. Forgetting it makes the next write read the row again. */
            this.stamps.delete(write.id);
          }
          this.host.onNote({ ok: true, text: write.done });
        } else {
          this.host.onRollback?.(write);
          this.host.onNote({
            ok: false,
            text: r.error ?? (r.conflict ? "Somebody changed that card while you had it open" : "That did not go through"),
          });
          // A refusal tells us nothing reliable about the stamp: re-read it.
          this.stamps.delete(write.id);
        }
      } catch (e) {
        this.host.onRollback?.(write);
        this.host.onNote({ ok: false, text: String((e as Error)?.message || e) });
        this.stamps.delete(write.id);
      } finally {
        this.out.delete(slot);
        this.host.onChange();
      }
    });

    /* The chain must never reject, or every later write to this card is dropped.
       Errors are already reported above. */
    this.chains.set(write.id, mine.catch(() => {}));
    return mine;
  }

  /** A fresh read of the board is the authority: drop the stamps we were carrying
   *  so nothing is written against a number nobody has checked. Writes still out
   *  keep their own place in the queue. */
  reset(): void {
    this.stamps.clear();
  }
}
