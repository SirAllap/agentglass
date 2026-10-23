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
import { SettingRow } from "./SettingRow.tsx";
import { EmptyState, Field, SettingsCard, SettingsForm, helpIdFor } from "./SettingsKit.tsx";

interface Reply { id: string; title: string; text: string }


export function SavedRepliesPane({ open }: { open: boolean }) {
  const [replies, setReplies] = useState<Reply[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /** The one being edited, by id — or `""` for the new one being written. */
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");

  useEffect(() => {
    if (!open) return;
    let live = true;
    api.savedReplies().then((r) => { if (live) setReplies(r.replies ?? []); }).catch(() => { if (live) setReplies([]); });
    return () => { live = false; };
  }, [open]);

  /* Every write answers with the whole list, so the pane never has to guess what the
     file now says — and the composer's cache is dropped, or a reply saved here would
     not be in the menu until the window was reloaded. */
  const after = (list: Reply[] | undefined) => {
    setReplies(list ?? []);
    bumpSavedReplies();
    setEditing(null); setTitle(""); setText("");
  };

  const save = async () => {
    if (!text.trim()) { setErr("A saved reply needs something to say."); return; }
    setBusy(true); setErr("");
    const r = await api.saveReply({ ...(editing ? { id: editing } : null), title: title.trim(), text });
    setBusy(false);
    if (!r.ok) { setErr(r.error || "That did not save."); return; }
    after(r.replies);
  };

  const remove = async (id: string) => {
    setBusy(true);
    const r = await api.removeReply(id);
    setBusy(false);
    after(r.replies);
  };

  const editRow = (r: Reply) => { setEditing(r.id); setTitle(r.title); setText(r.text); setErr(""); };

  /* A card, like every other settings page: the replies are rows, Edit is
     the one action on a row, and the form that writes one is the card's last
     row, always there, so adding is not behind a button. Delete is beside Save
     only while a reply is open for editing, apart from it at the far end. */
  return (
    <SettingsCard title="Saved replies"
      desc="Offered in every comment box in the pull request panel, under the quote button. Nothing ships in this list — these go out under your name.">
      {replies === null && <EmptyState>Reading…</EmptyState>}
      {replies !== null && replies.length === 0 && editing === null && <EmptyState>Nothing saved yet.</EmptyState>}
      {replies?.map((r) => (
        <SettingRow key={r.id} label={r.title}
          /* The text itself is what a person wrote to post under their own
             name — the same reason a pull request body reads in --font-prose
             rather than the app's mono stack. Shown whole: a reply is a
             sentence or two, and a cut one hides the word that tells it from
             the next. */
          hint={<span className="block whitespace-pre-wrap" style={{ fontFamily: "var(--font-prose)", lineHeight: 1.5 }}>{r.text}</span>}
          actions={<Button onClick={() => editRow(r)} disabled={busy}>Edit</Button>} />
      ))}

      <div className="agx-settings-row">
        <div className="agx-row-below">
          <SettingsForm label={editing ? "Edit this reply" : "New reply"} onSubmit={() => void save()}>
            <div className="text-[13.5px]" style={{ color: "var(--text)" }}>{editing ? "Edit this reply" : "New reply"}</div>
            <Field label="Title" htmlFor="saved-reply-title" help="What the menu shows. Left empty, the first line is used.">
              <input id="saved-reply-title" value={title} onChange={(e) => setTitle(e.target.value)}
                aria-describedby={helpIdFor("saved-reply-title")} className={`w-full ${INPUT}`} style={INPUT_STYLE} />
            </Field>
            <Field label="Reply" htmlFor="saved-reply-text" help="What goes in the box. Markdown works here.">
              <textarea id="saved-reply-text" value={text} onChange={(e) => setText(e.target.value)} rows={5}
                aria-describedby={helpIdFor("saved-reply-text")}
                className="w-full px-2.5 py-2 rounded-lg text-[12px] outline-none resize-y bg-[var(--surface-inset)] text-[var(--text)]"
                style={{ ...INPUT_STYLE, fontFamily: "var(--font-prose)", lineHeight: 1.5 }} />
            </Field>
            <div className="agx-sform-actions">
              <Button type="submit" tone="primary" disabled={busy || !text.trim()}>{editing ? "Save" : "Add"}</Button>
              {editing !== null && (
                <Button onClick={() => { setEditing(null); setTitle(""); setText(""); setErr(""); }}>Cancel</Button>
              )}
              {editing && <span className="flex-1" />}
              {editing && (
                <Button tone="danger" onClick={() => void remove(editing)} disabled={busy} title="Delete this saved reply">Delete</Button>
              )}
            </div>
            {err && <div role="alert" className="agx-field-e">{err}</div>}
          </SettingsForm>
        </div>
      </div>
    </SettingsCard>
  );
}
