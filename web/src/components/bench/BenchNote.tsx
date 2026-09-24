/*
 * A note, per checkout.
 *
 * "What did I just find out" is the shortest-lived and most-lost piece of
 * writing there is: it belongs to the branch you are on, it is worth nothing a
 * week later, and today it goes into a chat message or a scratch buffer that
 * disappears. The bench is where it can live for as long as the worktree does.
 *
 * NOT a file in the repository, which is the tempting version and the wrong
 * one: an untracked file in somebody's checkout shows up in their status, in
 * their `git add -A`, and eventually in a commit nobody meant to make. It is
 * kept in the app's own data directory, keyed by the checkout's path — so it
 * follows the worktree, and disappears with the app rather than with the branch.
 *
 * The whole editor is a textarea. What this is for is a paragraph you will read
 * tomorrow; a rich editor here would be a second markdown viewer to maintain,
 * and there is a perfectly good one already for the files that deserve it.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { termOptions } from "../../lib/termPrefs.ts";

type Save = "clean" | "typing" | "saving" | "saved" | "failed";

export function BenchNote({ root, active }: {
  root: string;
  /** Is this the tab on screen? Tabs stay mounted when they are not, so a note
   *  cannot take the caret on mount alone. */
  active: boolean;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState<Save>("clean");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  /* Read each time it comes on screen, not once per mount: the bench is kept
     while it is closed, and the same note can be edited from another client in
     between — a note read an hour ago and typed into would save over the newer
     one. Not while an edit of ours is waiting to be saved: that is newer. */
  const pending = useRef(false);
  const edits = useRef(0);
  useEffect(() => {
    if (!active || pending.current) return;
    let live = true;
    /* And not if anything was typed while it was asked for: a slow answer that
       arrives after that edit has saved is older than what is on screen. */
    const at = edits.current;
    api.benchNote(root)
      .then((r) => { if (live && !pending.current && edits.current === at) { setText(r.ok ? r.text : ""); setError(r.ok ? null : (r.error ?? null)); } })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [root, active]);

  /* Saved on a pause rather than on every keystroke, and on unmount rather than
     never: a note that only saves when you remember to press something is a
     note you will lose exactly once. */
  const save = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    setState("typing");
    pending.current = true;
    const mine = ++edits.current;
    timer.current = setTimeout(async () => {
      setState("saving");
      try {
        const r = await api.benchNoteSave(root, next);
        setState(r.ok ? "saved" : "failed");
        setError(r.ok ? null : (r.error ?? "could not save this note"));
        /* Still pending if it failed, or if more was typed while it saved. */
        pending.current = !r.ok || edits.current !== mine;
      } catch (e) { setState("failed"); setError(String(e)); }
    }, 600);
  };

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /* The caret goes in the note when the note is what you are looking at.
     Without it the first thing typed goes wherever the focus happened to be —
     measured, and where it happened to be was a commit box in the view behind
     the window. The delay lets the tab finish becoming visible; focusing a
     hidden element scrolls its container in some browsers. */
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => box.current?.focus(), 40);
    return () => clearTimeout(t);
  }, [active]);

  const tp = termOptions();
  return (
    <div className="w-full h-full flex flex-col" style={{ background: "var(--bg)" }}>
      <textarea
        ref={box}
        value={text}
        onChange={(e) => { setText(e.target.value); save(e.target.value); }}
        /* The keys inside a note are the note's. Without this, Ctrl+PageDown
           would walk the bench's tabs from inside a paragraph. */
        onKeyDown={(e) => e.stopPropagation()}
        spellCheck={false}
        placeholder={"What you just found out.\nIt stays with this checkout."}
        className="flex-1 min-h-0 w-full resize-none bg-transparent outline-none px-4 py-3"
        style={{ color: "var(--text)", fontFamily: tp.fontFamily, fontSize: tp.fontSize, lineHeight: 1.55 }} />
      <div className="flex items-center gap-3 px-3 py-1.5 text-[10px] shrink-0"
        style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 14%, transparent)", color: "var(--text4)" }}>
        <span>{root.split("/").filter(Boolean).pop()}</span>
        <span className="ml-auto" style={{ color: state === "failed" ? "var(--error)" : undefined }}>
          {error ?? ({ clean: "", typing: "…", saving: "saving", saved: "saved", failed: "not saved" }[state])}
        </span>
      </div>
    </div>
  );
}
