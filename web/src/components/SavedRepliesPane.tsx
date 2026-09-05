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

interface Reply { id: string; title: string; text: string }

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;

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

  return (
    /* This page had no group at all — no card, no heading of the kind every
       other settings page has, just a stack of divs on the page's own ground.
       It is the shape now, so the one CSS rule that draws a settings group
       reaches it too. */
    <div className="agx-settings-section">
      <div className="agx-settings-head">
        <div className="agx-settings-head-t">Saved replies</div>
        <div className="agx-settings-head-d">
          Offered in every comment box in the pull request panel, under ⌸. Nothing ships in
          this list — these go out under your name.
        </div>
      </div>
      <div className="flex flex-col gap-2 py-2">

      {replies === null ? (
        <div className="px-3 py-2 text-[11px]" style={{ color: "var(--text3)" }}>Reading…</div>
      ) : replies.length === 0 && editing === null ? (
        <div className="px-3 py-2 text-[11px]" style={{ color: "var(--text3)" }}>Nothing saved yet.</div>
      ) : (
        <div className="flex flex-col gap-1 px-3">
          {replies.map((r) => (
            <div key={r.id} className="rounded-lg px-2.5 py-2 flex items-start gap-2" style={{ border: edge(14) }}>
              <div className="min-w-0 flex-1">
                <div className="text-[11.5px]" style={{ color: "var(--text)" }}>{r.title}</div>
                {/* Two lines of it, so a list of twelve is still a list. The whole
                    thing is one press away. */}
                <div className="text-[10.5px] mt-0.5" style={{
                  color: "var(--text3)", display: "-webkit-box", WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "pre-wrap",
                }}>{r.text}</div>
              </div>
              <button onClick={() => editRow(r)} disabled={busy}
                className="agx-btn shrink-0 px-2 py-0.5 rounded text-[10.5px]"
                style={{ color: "var(--text2)", border: edge(20) }}>Edit</button>
              <button onClick={() => void remove(r.id)} disabled={busy}
                title="Delete this saved reply"
                className="agx-btn shrink-0 px-2 py-0.5 rounded text-[10.5px]"
                style={{ color: "var(--error)", border: "1px solid color-mix(in srgb, var(--error) 35%, transparent)" }}>Delete</button>
            </div>
          ))}
        </div>
      )}

      <div className="px-3 pb-2 flex flex-col gap-1.5">
        <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>
          {editing ? "Edit this reply" : "New reply"}
        </div>
        <input value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="What the menu shows — left empty, the first line is used"
          className="px-2 py-1 rounded text-[11px] outline-none"
          style={{ background: "var(--bg2)", color: "var(--text)", border: edge(16) }} />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5}
          placeholder="What goes in the box. Markdown works here."
          className="px-2 py-1.5 rounded text-[11px] outline-none resize-y"
          style={{ background: "var(--bg2)", color: "var(--text)", border: edge(16), fontFamily: "var(--diff-font, ui-monospace, monospace)" }} />
        {err && <div className="text-[10.5px]" style={{ color: "var(--error)" }}>{err}</div>}
        <div className="flex items-center gap-1.5">
          <button onClick={() => void save()} disabled={busy || !text.trim()}
            className="agx-btn px-2 py-1 rounded text-[10.5px] disabled:opacity-40"
            style={{ color: "var(--text)", border: "1px solid color-mix(in srgb, var(--primary) 50%, transparent)" }}>
            {editing ? "Save" : "Add"}
          </button>
          {editing !== null && (
            <button onClick={() => { setEditing(null); setTitle(""); setText(""); setErr(""); }}
              className="agx-btn px-2 py-1 rounded text-[10.5px]" style={{ color: "var(--text3)" }}>Cancel</button>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
