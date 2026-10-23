// The sentences you write over and over on other people's pull requests.
//
// "Thanks — we will take this on from here." "This needs a test that fails without
// the fix." Typing them again every time is how they end up shorter and blunter than
// intended; GitHub has had saved replies for years for that reason, and the composer
// in this app had nothing.
//
// Nothing ships in this list. A canned sentence that arrives with the app is the app
// putting words in somebody's mouth, and these get posted under their name to other
// people — so it starts empty, and says so.

import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { bumpSavedReplies } from "./PrPanel.tsx";
import { Button, INPUT, INPUT_STYLE } from "./workspace/Chrome.tsx";
import { Field, SettingsForm, helpIdFor } from "./SettingsKit.tsx";
import { EditorFoot, EditorPanel, ListBar, ListEditorSplit, ListPanel, NewButton, NothingSelected, differs } from "./SettingsListEditor.tsx";
import { QuoteIcon } from "./settingsNavIcons.tsx";
import { useReportHead, useReportSaving } from "./SettingsPageState.tsx";
import { ICON } from "../lib/iconSize.ts";

interface Reply { id: string; title: string; text: string }

export function SavedRepliesPane({ open }: { open: boolean }) {
  const [replies, setReplies] = useState<Reply[] | null>(null);
  const [busy, setBusy] = useState(false);
  useReportSaving("saved-replies", busy);
  const [err, setErr] = useState("");
  /** The one being edited, by id — or `""` for the new one being written; null until one is picked. */
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useReportHead("saved-replies", { action: { label: "New reply" } }, () => newOne());

  useEffect(() => {
    if (!open) return;
    let live = true;
    api.savedReplies().then((r) => { if (live) setReplies(r.replies ?? []); }).catch(() => { if (live) setReplies([]); });
    return () => { live = false; };
  }, [open]);

  const editRow = (r: Reply) => { setEditing(r.id); setTitle(r.title); setText(r.text); setErr(""); };
  const clear = () => { setEditing(null); setTitle(""); setText(""); setErr(""); };
  const newOne = () => { setEditing(""); setTitle(""); setText(""); setErr(""); };

  /* The first reply is open when the page is: an editor with nothing in it, beside a list, reads as broken. */
  useEffect(() => {
    if (replies?.length && editing === null) editRow(replies[0]!);
  }, [replies, editing]);

  /* Every write answers with the whole list, so the pane never has to guess what the
     file now says — and the composer's cache is dropped, or a reply saved here would
     not be in the menu until the window was reloaded. */
  const after = (list: Reply[] | undefined, keep?: string) => {
    setReplies(list ?? []);
    bumpSavedReplies();
    const next = keep ? list?.find((r) => r.id === keep) : undefined;
    if (next) editRow(next); else clear();
  };

  const save = async () => {
    if (!text.trim()) { setErr("A saved reply needs something to say."); return; }
    setBusy(true); setErr("");
    const r = await api.saveReply({ ...(editing ? { id: editing } : null), title: title.trim(), text });
    setBusy(false);
    if (!r.ok) { setErr(r.error || "That did not save."); return; }
    after(r.replies, editing || undefined);
  };

  const remove = async (id: string) => {
    setBusy(true);
    const r = await api.removeReply(id);
    setBusy(false);
    after(r.replies);
  };

  const saved = editing ? replies?.find((r) => r.id === editing) : undefined;
  const dirty = editing !== null && differs({ title, text }, saved ? { title: saved.title, text: saved.text } : null);
  const ql = q.trim().toLowerCase();
  const shown = (replies ?? []).filter((r) => !ql || `${r.title} ${r.text}`.toLowerCase().includes(ql));

  /* A list beside the editor, like the other pages that keep a list of your own words:
     the replies on the left, the one open on the right. The form is always there, so
     adding is not behind a button. Delete is in the editor's head, apart from Save. */
  return (
    <>
      <ListBar q={q} onQ={setQ} placeholder={`Filter ${replies?.length ?? 0} replies`} label="Filter saved replies" />
      <ListEditorSplit
        list={<ListPanel selected={editing || null} onSelect={(id) => { const r = replies?.find((x) => x.id === id); if (r) editRow(r); }}
          nothing={replies === null ? "Reading…" : "Nothing matches."}
          blank={replies?.length === 0 ? {
            icon: <QuoteIcon size={ICON.xl} />, title: "No saved replies yet",
            text: "A saved reply is a sentence you type often, one click away in every composer. Nothing ships in this list: these go out under your name, so every one is yours.",
            action: <NewButton onClick={newOne} disabled={busy}>New reply</NewButton>,
          } : undefined}
          sections={[{
            id: "replies", title: "Replies", onAdd: newOne, addLabel: "New reply",
            entries: shown.map((r) => ({
              id: r.id, title: r.title || <i>Untitled</i>,
              /* The text itself is what a person wrote to post under their own
                 name — the same reason a pull request body reads in --font-prose
                 rather than the app's mono stack. */
              sub: <span style={{ fontFamily: "var(--font-prose)" }}>{r.text.split("\n")[0]}</span>,
            })),
          }]} />}
        editor={editing === null ? <NothingSelected noun="reply" label="Saved reply" onNew={newOne} /> : (
          <EditorPanel label="Saved reply" title={title.trim() || "New reply"}
            chips={[editing ? { tone: "ok", text: "Saved" } : { tone: "info", text: "Draft" }]}
            actions={editing ? <Button tone="danger" onClick={() => void remove(editing)} disabled={busy} title="Delete this saved reply">Delete this saved reply</Button> : undefined}>
            <SettingsForm label={editing ? "Edit this reply" : "New reply"} onSubmit={() => void save()}>
              <div className="agx-le-body">
                <Field label="Title" htmlFor="saved-reply-title" help="What the menu shows. Left empty, the first line is used.">
                  <input id="saved-reply-title" value={title} onChange={(e) => setTitle(e.target.value)}
                    aria-describedby={helpIdFor("saved-reply-title")} className={`w-full ${INPUT}`} style={INPUT_STYLE} />
                </Field>
                <Field label="Reply" htmlFor="saved-reply-text" help="Markdown works. Used in every comment box of the pull request panel, under the quote button.">
                  <textarea id="saved-reply-text" value={text} onChange={(e) => setText(e.target.value)} rows={8}
                    aria-describedby={helpIdFor("saved-reply-text")}
                    className="w-full px-2.5 py-2 rounded-lg text-[12px] outline-none resize-y bg-[var(--surface-inset)] text-[var(--text)]"
                    style={{ ...INPUT_STYLE, fontFamily: "var(--font-prose)", lineHeight: 1.5 }} />
                </Field>
                {err && <div role="alert" className="agx-field-e">{err}</div>}
              </div>
              <EditorFoot dirty={dirty} canSave={!!text.trim()} noun="reply" busy={busy}
                onCancel={() => { const r = saved; if (r) editRow(r); else clear(); }} />
            </SettingsForm>
          </EditorPanel>
        )} />
    </>
  );
}
