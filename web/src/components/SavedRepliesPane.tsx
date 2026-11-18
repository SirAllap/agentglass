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
import { FormInput } from "./settings/shell/FormInput.tsx";
import { Section } from "./settings/shell/Section.tsx";
import { SettingRow } from "./settings/shell/SettingRow.tsx";
import { DangerAction, GroupActions } from "./settings/save/index.ts";
import { useReportSaving } from "./SettingsPageState.tsx";
import { differs } from "./SettingsListEditor.tsx";

interface Reply { id: string; title: string; text: string }

/** Saved replies as shell rows: one row per reply with Edit and Delete, and the editor as a section of its own rows. */
export function SavedRepliesPane({ open }: { open: boolean }) {
  const [replies, setReplies] = useState<Reply[] | null>(null);
  const [busy, setBusy] = useState(false);
  useReportSaving("saved-replies", busy);
  const [err, setErr] = useState("");
  /** The one being edited, by id, or `""` for the new one being written; null when none is open. */
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) return;
    let live = true;
    api.savedReplies().then((r) => { if (live) setReplies(r.replies ?? []); }).catch(() => { if (live) setReplies([]); });
    return () => { live = false; };
  }, [open]);

  const editRow = (r: Reply) => { setEditing(r.id); setTitle(r.title); setText(r.text); setErr(""); };
  const clear = () => { setEditing(null); setTitle(""); setText(""); setErr(""); };
  const newOne = () => { setEditing(""); setTitle(""); setText(""); setErr(""); };

  /* Every write answers with the whole list, so the pane never has to guess what the
     file now says, and the composer's cache is dropped, or a reply saved here would
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

  return (
    <>
      <Section id="replies" title="Saved replies" intro="Sentences you type often, one click away in every comment box. Every one is yours.">
        {replies === null && <SettingRow kind="fact" label="Reading your replies" value="…" />}
        {replies?.length === 0 && (
          <SettingRow kind="control" label="No saved replies yet" help="Nothing ships in this list: these go out under your name."
            control={<Button onClick={newOne} disabled={busy}>New reply</Button>} />
        )}
        {(replies?.length ?? 0) > 6 && (
          <SettingRow kind="control" label="Filter replies" help={`Search ${replies!.length} replies by title or text.`}
            control={<FormInput aria-label="Filter saved replies" value={q} onChange={(e) => setQ(e.target.value)} className={INPUT} style={INPUT_STYLE} />} />
        )}
        {replies && replies.length > 0 && shown.length === 0 && <SettingRow kind="fact" label="Nothing matches" value="" />}
        {shown.map((r) => (
          /* The text itself is what a person wrote, so its preview reads in the prose face, not the mono default. */
          <div key={r.id} data-reply-id={r.id} style={{ fontFamily: "var(--font-prose)" }}>
            <SettingRow kind="control" label={r.title || r.text.split("\n")[0]!.slice(0, 60) || "Untitled"} help={r.text.split("\n")[0]!.slice(0, 90)}
              control={<>
                <Button onClick={() => editRow(r)}>Edit</Button>
                <DangerAction label="Delete" onConfirm={() => remove(r.id)} />
              </>} />
          </div>
        ))}
        {replies && replies.length > 0 && editing === null && (
          <SettingRow kind="control" label="Write a new reply" help="It joins the list and the comment box menu." control={<Button onClick={newOne} disabled={busy}>New reply</Button>} />
        )}
      </Section>
      {editing !== null && (
        <Section id="replies-edit" title={editing ? "Edit this reply" : "New reply"}>
          <SettingRow kind="control" label="Title" help="Left empty, the first line is used."
            control={<FormInput id="saved-reply-title" aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} className={`w-full ${INPUT}`} style={INPUT_STYLE} />} />
          <SettingRow kind="control" label="Reply" help="Markdown works."
            control={
              <textarea id="saved-reply-text" aria-label="Reply" value={text} onChange={(e) => setText(e.target.value)} rows={8}
                className="w-full px-2.5 py-2 rounded-lg text-[12px] outline-none resize-y bg-[var(--surface-inset)] text-[var(--text)]"
                style={{ ...INPUT_STYLE, fontFamily: "var(--font-prose)", lineHeight: 1.5, minWidth: 260 }} />} />
          {err && <div role="alert" className="px-3 py-2 text-[12px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
          <div className="px-3 py-2.5">
            <GroupActions primary="Save reply" dirty={dirty && !!text.trim()} busy={busy} onPrimary={() => void save()}
              onCancel={() => { if (saved) editRow(saved); else clear(); }} />
          </div>
        </Section>
      )}
    </>
  );
}
