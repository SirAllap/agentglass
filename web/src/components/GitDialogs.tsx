import { useEffect, useRef, useState, type ReactNode } from "react";
import { GitDialog } from "./GitDialog.tsx";
import { INPUT, INPUT_STYLE, EDGE } from "./workspace/Chrome.tsx";
import { useOwnedQuestion } from "../lib/layerOwner.ts";
import { confirmVariant, tagPlan, type TagPlan } from "../lib/gitDialog.ts";

/**
 * The Git panel's own `ask` / `askText`, answered in GitDialog.
 *
 *   if (!(await ask({ title: "Drop this stash?", danger: true, command: "git stash drop 'stash@{0}'" }))) return;
 *
 * The same promise shape the panel already reads top to bottom, so a handler
 * does not change when its question is redrawn.
 */

export type GitQuestion = {
  /** A sentence ending in "?" for a confirm; a short label for a prompt. */
  title: string;
  /** One plain line under the title, newlines kept. */
  body?: string;
  node?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive: starts on Cancel, Enter does not confirm, red button. */
  danger?: boolean;
  /** The git the answer runs. Only where the catalogue states it. */
  command?: string;
  /** Nothing (no reflog, no trash) brings it back: says so under the command. */
  irreversible?: boolean;
  input?: { label?: string; initial?: string; placeholder?: string };
};

export type TagAnswer = { name: string; message: string; annotated: boolean; signed: boolean };

type Pending =
  | ({ kind: "ask"; resolve: (v: boolean | string | null) => void } & GitQuestion)
  | { kind: "tag"; resolve: (v: TagAnswer | null) => void };

export function GitQuestionDialog({ pending }: { pending: Pending | null }) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [annotated, setAnnotated] = useState(false);
  const [signed, setSigned] = useState(false);
  const seen = useRef<Pending | null>(null);
  useEffect(() => {
    if (!pending || seen.current === pending) return;
    seen.current = pending;
    setText(pending.kind === "ask" ? pending.input?.initial ?? "" : "");
    setName(""); setAnnotated(false); setSigned(false);
  }, [pending]);
  if (!pending) return null;

  if (pending.kind === "tag") {
    const plan: TagPlan = tagPlan(name, annotated, signed, text);
    const send = () => { if (plan.ok) pending.resolve({ name: name.trim(), message: plan.opts.message, annotated: plan.opts.annotated, signed: plan.opts.signed }); };
    return (
      <GitDialog title="New tag" subtitle="A tag names one commit, usually a release." tone="primary"
        confirmLabel="Create" onConfirm={send} confirmDisabled={!plan.ok}
        reason={plan.reason || (annotated || signed ? "Create adds an annotated tag." : "Create adds a lightweight tag unless you write a message.")}
        initialFocus="input" onClose={() => pending.resolve(null)}>
        <label className="flex flex-col gap-1 text-[11.5px]" style={{ color: "var(--text3)" }}>Tag name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="v1.2.3" className={`w-full ${INPUT}`} style={INPUT_STYLE} />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px]" style={{ color: "var(--text3)" }}>
          {annotated || signed ? "Message (required)" : "Message (optional)"}
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="What this release is"
            className={`w-full resize-none ${INPUT}`} style={{ ...INPUT_STYLE, height: "auto", minHeight: 64 }} />
        </label>
        <div className="flex items-center gap-4 text-[11.5px]" style={{ color: "var(--text2)" }}>
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={annotated || signed} disabled={signed} onChange={(e) => setAnnotated(e.target.checked)} />Annotated
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={signed} onChange={(e) => setSigned(e.target.checked)} />Signed
          </label>
        </div>
      </GitDialog>
    );
  }

  const isPrompt = !!pending.input;
  const v = confirmVariant({ danger: pending.danger, hasInput: isPrompt, command: pending.command, irreversible: pending.irreversible });
  const answer = () => pending.resolve(isPrompt ? text.trim() : true);
  const cancel = () => pending.resolve(isPrompt ? null : false);
  const label = pending.confirmLabel ?? (pending.danger ? "Delete" : "Ok");
  return (
    <GitDialog title={pending.title} subtitle={pending.body ? <span className="whitespace-pre-wrap">{pending.body}</span> : undefined}
      tone={v.tone} danger={pending.danger} command={pending.command} cannotUndo={v.cannotUndo}
      confirmLabel={label} cancelLabel={pending.cancelLabel} onConfirm={answer} confirmDisabled={isPrompt && !text.trim()}
      reason={pending.danger ? undefined : isPrompt && !text.trim() ? "Type a value first." : `Press ${label} to go ahead.`}
      initialFocus={v.focus} enterConfirms={v.enterConfirms} onClose={cancel}>
      {pending.node}
      {isPrompt && (
        <label className="flex flex-col gap-1 text-[11.5px]" style={{ color: "var(--text3)" }}>
          {pending.input!.label}
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={pending.input!.placeholder}
            className={`w-full ${INPUT}`} style={{ ...INPUT_STYLE, border: EDGE }} />
        </label>
      )}
    </GitDialog>
  );
}

/**
 * `const { ask, askText, askTag, dialog } = useGitDialogs()` — render `dialog`,
 * await the rest. One question at a time; a second one answers the first "no".
 */
export function useGitDialogs() {
  const [pending, setPending] = useState<Pending | null>(null);
  const open = useRef<Pending | null>(null);
  const noteAsker = useOwnedQuestion(pending, () => decline());
  const decline = () => {
    const p = open.current;
    if (p) p.resolve((p.kind === "ask" && !p.input ? false : null) as never);
  };
  const put = (spec: Omit<Pending, "resolve">, resolve: (v: never) => void) => {
    decline();
    noteAsker();
    const next = { ...spec, resolve: (v: never) => { open.current = null; setPending(null); resolve(v); } } as Pending;
    open.current = next;
    setPending(next);
  };
  const ask = (q: GitQuestion) => new Promise<boolean>((r) => put({ kind: "ask", ...q }, r as never));
  const askText = (q: GitQuestion & { input: NonNullable<GitQuestion["input"]> }) =>
    new Promise<string | null>((r) => put({ kind: "ask", ...q }, r as never));
  const askTag = () => new Promise<TagAnswer | null>((r) => put({ kind: "tag" }, r as never));
  return { ask, askText, askTag, open: pending !== null, dialog: <GitQuestionDialog pending={pending} /> };
}
