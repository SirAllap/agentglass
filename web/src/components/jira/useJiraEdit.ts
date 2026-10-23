/*
 * The state of changing a Jira card's Details from its pane: which field is
 * being saved, the sentence said after one landed (with its Undo) or after one
 * was refused, and the one request that does it.
 *
 * One edit at a time: the card's stamp moves with each, and a second sent
 * before the first is answered would be checked against a stamp that is about
 * to be stale. A refusal because the card moved says so and asks the pane to
 * read the card again; nothing is retried here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type JiraEditAsk } from "../../lib/api.ts";
import type { EditNow, EditStep } from "../../lib/jiraEdit.ts";
import type { CardEdit, CardFact, ProviderTask } from "../../../../shared/providers.ts";

export interface EditNote { text: string; warn?: boolean; undo?: JiraEditAsk }

/** What the pane's parts are given to change the card with. */
export interface JiraEditUi {
  edit: CardEdit | undefined;
  /** The field being saved, or "". */
  busy: string;
  now: EditNow;
  run: (step: EditStep) => void;
}

export function useJiraEdit(o: {
  cardKey: string;
  /** The card's stamp as the pane has it; read at the moment an edit is sent. */
  stamp: number;
  onDone: (r: { task: ProviderTask; facts?: CardFact[]; edit?: CardEdit }) => void;
  /** The card moved under the person: read it again. */
  onStale: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<EditNote | null>(null);
  const keyRef = useRef(o.cardKey);
  keyRef.current = o.cardKey;
  const stamp = useRef(o.stamp);
  stamp.current = o.stamp;
  const cb = useRef(o);
  cb.current = o;
  const going = useRef(false);

  // A said line belongs to the card it was said about.
  useEffect(() => { setNote(null); setBusy(""); going.current = false; }, [o.cardKey]);

  const run = useCallback((step: EditStep) => {
    if (going.current) return;
    going.current = true;
    const forKey = keyRef.current;
    setBusy(step.ask.field); setNote(null);
    void api.jiraEdit(forKey, step.ask, stamp.current)
      .catch(() => ({ ok: false as const, error: "Could not reach agentglass" } as Awaited<ReturnType<typeof api.jiraEdit>>))
      .then((r) => {
        if (forKey !== keyRef.current) return;
        if (r.ok && r.task) {
          cb.current.onDone({ task: r.task, facts: r.facts, edit: r.edit });
          setNote({ text: step.said, ...(step.undo ? { undo: step.undo } : {}) });
        } else {
          // The server's sentence for a moved card is longer than the line has room for; this one says the same in what fits.
          setNote({ text: r.conflict ? "Changed in Jira meanwhile: reloaded, nothing sent" : r.error || "Jira refused that change", warn: true });
          if (r.conflict) cb.current.onStale();
        }
      })
      .finally(() => { going.current = false; if (forKey === keyRef.current) setBusy(""); });
  }, []);

  const undo = useCallback(() => {
    const ask = note?.undo;
    if (ask) run({ ask, said: `Put back (${note.text})`, undo: null });
  }, [note, run]);

  return { busy, note, run, undo, clear: () => setNote(null) };
}
