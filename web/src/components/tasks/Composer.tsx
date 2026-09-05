/*
 * Writing a comment on a card, with the formatting ClickUp will actually show.
 *
 * The point of the toolbar is not the buttons — anybody can type `**` — it is
 * that what is written here ARRIVES formatted. Until now the app sent
 * `comment_text`, which ClickUp prints verbatim, so a bulleted note landed on
 * the card as dashes. The conversion happens on the way out (clickupDelta.ts);
 * this is the half that lets somebody write it.
 *
 * The preview is the card's own markdown renderer, so what is drawn here is
 * what the panel draws for a comment somebody else wrote — the closest thing to
 * seeing it in ClickUp without posting it.
 *
 * `@` opens the people menu, which is the control he reaches for most and the
 * one this did not have. What it inserts is text; what makes it ARRIVE is the
 * send handing the comment to whoever was named — see mentions.ts, and the note
 * under the box, which says so rather than letting somebody believe a plain
 * `@Name` notifies anybody.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "../../lib/markdown.tsx";
import { bold, bullet, checklist, code, fence, heading, italic, link, newline, ordered, quote, strike, table, type Sel } from "../../lib/mdEditor.ts";
import { insertMention, matchPeople, mentionQuery, menuPlacement, MENU_MAX, type Mentionable } from "../../lib/mentions.ts";

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;

/** One icon, drawn rather than spelled.
 *
 *  The row used to be letters and punctuation — `B I S <> Link H • 1. ☑ " { } ▦`
 *  — which reads as a line of text somebody forgot to delete rather than as
 *  controls. 14px strokes on a 24px hit area: the same floor every other icon
 *  in this app is held to. */
function Ink({ d, text }: { d?: string; text?: string }) {
  if (text) return <span className="text-[12px] leading-none font-semibold" aria-hidden>{text}</span>;
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

type Tool = {
  id: string;
  title: string;
  run: (s: Sel) => Sel;
  chord?: string;
  /** A path for the icon, or a letter when a letter IS the icon (bold, italic). */
  d?: string;
  text?: string;
  style?: React.CSSProperties;
};

/* Grouped the way the work is: the marks you put on a word, then the things
   that make a line, then the blocks. The dividers are what stop it reading as
   one undifferentiated row of twelve. */
const GROUPS: Tool[][] = [
  [
    { id: "bold", title: "Bold  (Ctrl+B)", run: bold, chord: "b", text: "B" },
    { id: "italic", title: "Italic  (Ctrl+I)", run: italic, chord: "i", text: "I", style: { fontStyle: "italic", fontFamily: "Georgia, serif" } },
    { id: "strike", title: "Strikethrough", run: strike, text: "S", style: { textDecoration: "line-through" } },
    { id: "code", title: "Inline code", run: code, d: "M8 6l-5 6 5 6M16 6l5 6-5 6" },
  ],
  [
    { id: "link", title: "Link  (Ctrl+K)", run: (s) => link(s), chord: "k", d: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" },
    { id: "h", title: "Heading", run: heading, text: "H" },
  ],
  [
    { id: "ul", title: "Bulleted list", run: bullet, d: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" },
    { id: "ol", title: "Numbered list", run: ordered, d: "M10 6h11M10 12h11M10 18h11M4 6V4h1M3 10h2l-2 3h2M3 16h2v2H3v2h2" },
    { id: "task", title: "Checklist", run: checklist, d: "M3 6l2 2 3-3M3 14l2 2 3-3M12 7h9M12 15h9" },
  ],
  [
    { id: "quote", title: "Quote", run: quote, d: "M7 15V9a4 4 0 0 0-4 4v2h4zM18 15V9a4 4 0 0 0-4 4v2h4z" },
    { id: "pre", title: "Code block", run: (s) => fence(s), d: "M3 5h18v14H3zM7 10l-2 2 2 2M17 10l2 2-2 2" },
    { id: "table", title: "Table", run: table, d: "M3 5h18v14H3zM3 10h18M9 10v9M15 10v9" },
  ],
];

export function Composer({ value, onChange, onSend, onCancel, busy, placeholder, sendLabel, autoFocus, people, onNeedPeople }: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  /** Absent for the card's own box — there is nothing to cancel back to. */
  onCancel?: () => void;
  busy: boolean;
  placeholder: string;
  sendLabel: string;
  autoFocus?: boolean;
  /** Who can be named. Absent while they are being fetched, which is why the
   *  menu says "reading the list" rather than "nobody". */
  people?: (Mentionable & { initials?: string; color?: string; avatar?: string })[] | null;
  /** Asked the first time somebody types `@` — a card is read far more often
   *  than it is commented on, and the roster is a call. */
  onNeedPeople?: () => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState(false);
  /** Where to put the caret after a button ran. Applied in an effect because
   *  the textarea's value is React's, and setting selection before the render
   *  lands puts it in the old string. */
  const [caret, setCaret] = useState<{ start: number; end: number } | null>(null);
  /** The mention being typed, and which row of the menu is under the cursor. */
  const [at, setAt] = useState<{ at: number; query: string } | null>(null);
  const [pick, setPick] = useState(0);

  useEffect(() => {
    if (!caret || !box.current) return;
    box.current.focus();
    box.current.setSelectionRange(caret.start, caret.end);
    setCaret(null);
  }, [caret, value]);

  const run = (fn: (s: Sel) => Sel) => {
    const el = box.current;
    if (!el) return;
    const out = fn({ text: value, start: el.selectionStart, end: el.selectionEnd });
    onChange(out.text);
    setCaret({ start: out.start, end: out.end });
  };

  /** Re-read the mention under the caret after anything that moves it. */
  const sniff = (text: string, where: number) => {
    const q = mentionQuery(text, where);
    setAt(q);
    setPick(0);
    if (q && !people && onNeedPeople) onNeedPeople();
  };

  /*
   * Which side of the box the menu goes on.
   *
   * Under it everywhere except where the composer already sits at the bottom of
   * a modal — the card view — and there the list ran off the end: "the mention
   * picker sort of runs off the bottom and I don't see the list the way I should".
   * Measured against the viewport while the menu is open, and re-measured on a
   * scroll or a resize, because both move the box under it.
   */
  const [place, setPlace] = useState({ up: false, maxHeight: MENU_MAX });
  useLayoutEffect(() => {
    if (!at) return;
    const put = () => {
      const r = shell.current?.getBoundingClientRect();
      if (r) setPlace(menuPlacement({ top: r.top, bottom: r.bottom }, window.innerHeight));
    };
    put();
    window.addEventListener("resize", put);
    // Capture: the box moves with whichever pane is scrolling, and that scroll
    // never reaches the window.
    window.addEventListener("scroll", put, true);
    return () => { window.removeEventListener("resize", put); window.removeEventListener("scroll", put, true); };
  }, [at]);

  const rows = at && people ? matchPeople(people, at.query) : [];
  const take = (name: string) => {
    if (!at) return;
    const out = insertMention(value, at, name);
    onChange(out.text);
    setCaret({ start: out.caret, end: out.caret });
    setAt(null);
  };

  return (
    <div ref={shell} className="relative flex flex-col" style={{ borderRadius: 8, border: edge(16), background: "var(--bg)" }}>
      <div className="flex items-center gap-0.5 flex-wrap px-1.5 py-1"
        style={{ borderBottom: edge(12), background: "color-mix(in srgb, var(--text) 4%, transparent)" }}>
        {GROUPS.map((group, gi) => (
          <span key={gi} className="flex items-center gap-0.5">
            {gi > 0 && <span aria-hidden className="mx-1 self-stretch my-1" style={{ width: 1, background: "color-mix(in srgb, var(--text) 12%, transparent)" }} />}
            {group.map((t) => (
              <button key={t.id} type="button" title={t.title} aria-label={t.title} disabled={busy || preview}
                /* Never a submit: inside a form this toolbar would post the
                   comment on every press. And `onMouseDown` prevented, or the
                   textarea loses its selection before the handler reads it. */
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(t.run)}
                className="agx-btn inline-flex items-center justify-center rounded"
                style={{ width: 24, height: 24, color: "var(--text3)", ...t.style }}>
                <Ink d={t.d} text={t.text} />
              </button>
            ))}
          </span>
        ))}
        {/* The mention, as a button too: the chord is `@` and it is not
            discoverable, which is exactly what a toolbar is for. */}
        <span aria-hidden className="mx-1 self-stretch my-1" style={{ width: 1, background: "color-mix(in srgb, var(--text) 12%, transparent)" }} />
        <button type="button" title="Mention somebody  (@)" aria-label="Mention somebody" disabled={busy || preview}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const el = box.current;
            if (!el) return;
            const cut = el.selectionStart;
            const pad = cut > 0 && !/\s/.test(value[cut - 1] ?? " ") ? " " : "";
            const next = `${value.slice(0, cut)}${pad}@${value.slice(el.selectionEnd)}`;
            onChange(next);
            setCaret({ start: cut + pad.length + 1, end: cut + pad.length + 1 });
            sniff(next, cut + pad.length + 1);
          }}
          className="agx-btn inline-flex items-center justify-center rounded"
          style={{ width: 24, height: 24, color: "var(--text3)" }}>
          <Ink text="@" />
        </button>
        <span className="flex-1" />
        <button type="button" className="agx-btn rounded px-2 text-[10.5px]" style={{ height: 24, color: preview ? "var(--info)" : "var(--text3)" }}
          title={preview ? "Back to writing" : "See it the way the card will"}
          onClick={() => setPreview((v) => !v)}>
          {preview ? "Write" : "Preview"}
        </button>
      </div>

      {preview
        ? <div className="px-2.5 py-2 text-[11.5px]" style={{ minHeight: 72 }}>
            {value.trim()
              ? <Markdown text={value} />
              : <span style={{ color: "var(--text4)" }}>Nothing to preview yet.</span>}
          </div>
        : <textarea ref={box} value={value} autoFocus={autoFocus} disabled={busy} placeholder={placeholder}
            onChange={(e) => { onChange(e.target.value); sniff(e.target.value, e.target.selectionStart); }}
            onClick={(e) => sniff(value, e.currentTarget.selectionStart)}
            onBlur={() => setAt(null)}
            onKeyDown={(e) => {
              const mod = e.metaKey || e.ctrlKey;
              /* The menu owns the keys that drive it, and only while it has
                 something to show — otherwise Enter would be swallowed by a
                 list nobody can see. */
              if (at && rows.length && !mod) {
                if (e.key === "ArrowDown") { e.preventDefault(); setPick((n) => (n + 1) % rows.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setPick((n) => (n - 1 + rows.length) % rows.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); take(rows[pick]!.name); return; }
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setAt(null); return; }
              }
              if (mod && e.key === "Enter") { e.preventDefault(); onSend(); return; }
              if (mod) {
                const tool = GROUPS.flat().find((t) => t.chord === e.key.toLowerCase());
                if (tool) { e.preventDefault(); run(tool.run); return; }
              }
              if (e.key === "Enter" && !e.shiftKey && !mod) {
                // A list carries on by itself, which is the one editing
                // behaviour people notice the absence of.
                const el = e.currentTarget;
                const out = newline({ text: value, start: el.selectionStart, end: el.selectionEnd });
                if (out) { e.preventDefault(); onChange(out.text); setCaret({ start: out.start, end: out.end }); }
                return;
              }
              /* Escape belongs to whatever opened this — a reply box closes, the
                 card's own box keeps what is typed. It must not reach the modal
                 behind it and close the card with a comment half-written. */
              if (e.key === "Escape" && onCancel) { e.preventDefault(); e.stopPropagation(); onCancel(); }
            }}
            className="agx-scroll px-2.5 py-2 text-[11.5px] outline-none resize-y"
            style={{ background: "transparent", color: "var(--text)", minHeight: 84, fontFamily: "inherit" }} />}

      {/* The people menu. Anchored under the box rather than at the caret: a
          textarea gives no caret coordinates without measuring a mirror of
          itself, and the box is small enough that the difference is a few
          millimetres. */}
      {at && !preview && (
        <div data-mention-menu className="absolute left-2 right-2 rounded-lg shadow-2xl overflow-y-auto agx-scroll"
          style={{
            ...(place.up ? { bottom: "calc(100% - 30px)" } : { top: "calc(100% - 30px)" }),
            zIndex: 40, background: "var(--bg2)", border: edge(28), maxHeight: place.maxHeight,
          }}>
          {!people && <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>Reading who is on this list…</div>}
          {people && !rows.length && <div className="px-2.5 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>Nobody matches that.</div>}
          {rows.map((p, i) => (
            <button key={p.id} type="button"
              onMouseDown={(e) => { e.preventDefault(); take(p.name); }}
              onMouseEnter={() => setPick(i)}
              className="w-full text-left px-2 py-1.5 flex items-center gap-2 text-[11px]"
              style={{ background: i === pick ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent", color: "var(--text2)" }}>
              <span className="shrink-0 grid place-items-center rounded-full text-[9px]"
                style={{ width: 18, height: 18, background: p.color ?? "color-mix(in srgb, var(--text) 14%, transparent)", color: "#fff" }}>
                {p.avatar
                  ? <img src={p.avatar} alt="" width={18} height={18} style={{ borderRadius: "50%" }} />
                  : (p.initials || p.name.slice(0, 2)).toUpperCase()}
              </span>
              <span className="truncate">{p.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 px-2 py-1.5" style={{ borderTop: edge(12) }}>
        <span className="text-[10px]" style={{ color: "var(--text4)" }}>
          Markdown · <span style={{ color: "var(--text3)" }}>@</span> mentions · Ctrl+Enter sends
        </span>
        <span className="flex-1" />
        {onCancel && (
          <button type="button" className="agx-btn rounded px-2 text-[10.5px]" style={{ height: 24, color: "var(--text3)" }}
            onClick={onCancel} disabled={busy}>Cancel</button>
        )}
        <button type="button" className="agx-btn rounded px-2.5 text-[10.5px] font-medium" disabled={busy || !value.trim()}
          style={{
            height: 24,
            color: value.trim() ? "var(--primary-hover, var(--primary))" : "var(--text4)",
            border: `1px solid color-mix(in srgb, var(--primary) ${value.trim() ? 45 : 15}%, transparent)`,
            background: value.trim() ? "color-mix(in srgb, var(--primary) 12%, transparent)" : "transparent",
          }}
          onClick={onSend}>
          {busy ? "Sending…" : sendLabel}
        </button>
      </div>
    </div>
  );
}
