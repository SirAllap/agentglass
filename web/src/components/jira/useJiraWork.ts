/*
 * The state of logging time on a Jira card from its pane: the one request in
 * flight, the sentence said after one landed (with its Undo where Jira lets the
 * old thing go back), and the request itself.
 *
 * One at a time, as for a change to the card's Details: each write moves the
 * card's stamp, and a second sent before the first is answered would be checked
 * against a stamp that is about to be stale. A refusal because the card moved
 * says so and asks the pane to read the card again; nothing is retried here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { said, undoOf, type WorkCall, type WorkEntry, type WorkResult } from "../../lib/jiraWorklog.ts";
import type { TaskDetail } from "../../../../shared/providers.ts";

export interface WorkNote { text: string; warn?: boolean; undo?: WorkCall }

/** What the work log's parts are given to write with. */
export interface JiraWorkUi {
  /** A write is in flight. */
  busy: boolean;
  note: WorkNote | null;
  /** Counts the writes that landed, so the paged-in rows drawn from before one can be dropped. */
  epoch: number;
  /** Sends one call and answers once; `was` is the entry it is about, for the sentence. */
  run: (call: WorkCall, was?: WorkEntry) => Promise<WorkResult>;
  undo: () => void;
  clear: () => void;
}

export function useJiraWork(o: {
  cardKey: string;
  /** The card's stamp as the pane has it; read at the moment a write is sent. */
  stamp: number;
  /** The card as the write left it. */
  onDone: (detail: TaskDetail, more: number) => void;
  /** The card moved under the person, or the write landed but the card could not be read back: read it again. */
  onStale: () => void;
}): JiraWorkUi {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<WorkNote | null>(null);
  const [epoch, setEpoch] = useState(0);
  const keyRef = useRef(o.cardKey);
  keyRef.current = o.cardKey;
  const stamp = useRef(o.stamp);
  stamp.current = o.stamp;
  const cb = useRef(o);
  cb.current = o;
  const going = useRef(false);

  // A said line belongs to the card it was said about.
  useEffect(() => { setNote(null); setBusy(false); going.current = false; }, [o.cardKey]);

  const run = useCallback(async (call: WorkCall, was?: WorkEntry, text?: string): Promise<WorkResult> => {
    if (going.current) return { ok: false, error: "Wait for the last one to finish" };
    going.current = true;
    const forKey = keyRef.current;
    setBusy(true); setNote(null);
    const at = stamp.current;
    const r = await (call.op === "add" ? api.jiraWorklog(forKey, call.send, at)
      : call.op === "edit" ? api.jiraWorklogEdit(forKey, call.id, call.send, at)
      : api.jiraWorklogDelete(forKey, call.id, call.send, at))
      .catch(() => ({ ok: false as const, error: "Could not reach agentglass" } as Awaited<ReturnType<typeof api.jiraWorklog>>));
    going.current = false;
    if (forKey !== keyRef.current) return { ok: false, error: "Another card was picked" };
    setBusy(false);
    if (!r.ok) {
      // The server's sentence for a moved card is longer than the line has room for; this one says the same in what fits.
      if (r.conflict) { setNote({ text: "Changed in Jira meanwhile: reloaded, nothing sent", warn: true }); cb.current.onStale(); }
      return { ok: false, error: r.conflict ? "Changed in Jira meanwhile: reloaded, nothing sent" : r.error || "Jira refused that", ...(r.conflict ? { conflict: true } : {}) };
    }
    setEpoch((n) => n + 1);
    if (r.detail) cb.current.onDone(r.detail, r.more ?? 0); else cb.current.onStale();
    const result: WorkResult = { ok: true, entry: r.entry, before: r.before, after: r.after, ...(r.partial ? { partial: r.partial } : {}) };
    setNote({ text: r.partial ?? text ?? said(call, result, was), ...(r.partial ? { warn: true } : {}), ...(text ? {} : (() => { const u = undoOf(call, result, was); return u ? { undo: u } : {}; })()) });
    return result;
  }, []);

  const undo = useCallback(() => {
    const call = note?.undo;
    if (call) void run(call, undefined, call.op === "delete" ? "Taken back: the entry is gone and the remaining estimate is as it was." : "Put back: the time and the remaining estimate are as they were.");
  }, [note, run]);

  return { busy, note, epoch, run, undo, clear: () => setNote(null) };
}
