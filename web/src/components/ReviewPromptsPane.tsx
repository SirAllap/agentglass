/*
 * The "Review with Claude" menu, as a page you can edit.
 *
 * The menu behind that button used to be two prompts chosen for you. It is a
 * catalogue now, and the reason it is EDITABLE rather than merely longer is
 * that a review prompt is wording, and wording is personal: the sentence that
 * makes an agent give you `path:line` findings instead of an essay is one you
 * arrive at by tuning it three times, not one that ships right.
 *
 * Three shapes on this page, and the differences matter:
 *
 *  - a built-in, untouched. Delete hides it; the catalogue keeps improving it.
 *  - a built-in you have edited. Same id, so it still gets deleted-and-restored
 *    by "Reset", and the app can tell you which ones you have changed.
 *  - your own. Ranked after the built-ins in its group, yours to remove.
 *
 * A prompt can also BE a skill — `/pr-resolve-reviews {number}` — because for
 * the flows that already have one, the slash command is the prompt. The skill
 * line goes first and the body follows it as context, so the two are not an
 * either/or.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { ReviewRecipe, ReviewRecipeGroup, ReviewRecipeWhen, SkillInfo } from "../../../shared/types.ts";
import { SettingRow } from "./SettingRow.tsx";
import { bumpReviewRecipes } from "./PrPanel.tsx";

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--border) ${pct}%, transparent)`;

const GROUPS: { id: ReviewRecipeGroup; label: string; what: string }[] = [
  { id: "reviewing", label: "Reviewing", what: "Somebody else's pull request." },
  { id: "focused", label: "One thing only", what: "A single question, asked well — risk, tests, data, security." },
  { id: "mine", label: "Your pull request", what: "The ones where the work is yours." },
];

/** What each situation means, in the words the menu would use. Shown beside the
 *  field, because "asked" on its own is a word from a database. */
const WHEN: { id: ReviewRecipeWhen; label: string }[] = [
  { id: "any", label: "Always available, never suggested on its own" },
  { id: "asked", label: "When your review has been requested" },
  { id: "reviewed", label: "When you have reviewed it and it has moved since" },
  { id: "card", label: "When it carries a card id" },
  { id: "mine", label: "When it is yours" },
  { id: "mine-changes", label: "When it is yours and changes were requested" },
];

/** The placeholders, with what each one becomes. Clicking one puts it in the
 *  body — the alternative is remembering nine names, which nobody does. */
const TOKENS: [string, string][] = [
  ["{number}", "17598"],
  ["{repo}", "acme/shop"],
  ["{head}", "the commit it is pinned to"],
  ["{since}", "the commit your last review saw"],
  ["{branch}", "the head branch"],
  ["{title}", "its title"],
  ["{author}", "who opened it"],
  ["{url}", "its page"],
  ["{card}", "the card id in the branch"],
];

const blank = (group: ReviewRecipeGroup): ReviewRecipe => ({
  id: "", title: "", body: "", group, when: "any",
});

export function ReviewPromptsPane({ open }: { open: boolean }) {
  const [list, setList] = useState<ReviewRecipe[] | null>(null);
  const [editing, setEditing] = useState<ReviewRecipe | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try { const r = await api.prPrompts(); setList(r.recipes ?? []); } catch { setList([]); }
  }, []);
  useEffect(() => {
    if (!open) return;
    void load();
    // Skills, for the picker. A failure here is not an error on this page: it
    // only means the skill field falls back to being a text box.
    api.skills().then((r) => setSkills(r.skills ?? [])).catch(() => {});
  }, [open, load]);

  const after = async (text: string, ok = true) => {
    setNote({ ok, text });
    setEditing(null);
    await load();
    // The menu holds this list in a module cache so pressing the button does
    // not cost a round trip. This is the one event that invalidates it.
    bumpReviewRecipes();
  };

  const save = async (r: ReviewRecipe) => {
    const res = await api.prPromptSave(r);
    if (!res.ok) { setNote({ ok: false, text: res.error ?? "That did not save" }); return; }
    await after(`${r.title} saved`);
  };
  const drop = async (r: ReviewRecipe) => {
    await api.prPromptRemove(r.id).catch(() => {});
    await after(r.builtIn ? `${r.title} hidden — “Restore built-ins” brings it back` : `${r.title} removed`);
  };
  const reset = async (r: ReviewRecipe) => {
    await api.prPromptReset(r.id).catch(() => {});
    await after(`${r.title} back to the wording it ships with`);
  };

  if (!list) return <Wrap><div className="py-3 text-[12.5px]" style={{ color: "var(--text3)" }}>Reading your prompts…</div></Wrap>;

  const hidden = GROUPS.flatMap((g) => list.filter((r) => r.group === g.id)).length;

  return (
    <Wrap>
      <p className="text-[12px] pb-1" style={{ color: "var(--text3)" }}>
        What the ✦ Review with Claude button offers on a pull request. The one that fits the pull request in front of you is
        suggested at the top; the rest are always in the menu, because GitHub's fields describe what somebody remembered to set.
      </p>

      {note && (
        <div className="my-2 text-[12px] px-2 py-1 rounded"
          style={{ color: note.ok ? "var(--success)" : "var(--error)",
            background: `color-mix(in srgb, var(--${note.ok ? "success" : "error"}) 10%, transparent)` }}>
          {note.text}
        </div>
      )}

      {GROUPS.map((g) => {
        const rows = list.filter((r) => r.group === g.id);
        return (
          <div key={g.id} className="pt-2">
            <div className="flex items-baseline gap-2 pb-1">
              <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>{g.label}</span>
              <span className="text-[11px]" style={{ color: "var(--text4)" }}>{g.what}</span>
            </div>
            {rows.map((r) => (
              <Fragment key={r.id}>
              <SettingRow
                label={<span className="flex items-center gap-1.5">
                  {r.skill && <span className="text-[10px] px-1 rounded" style={{ color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}>skill</span>}
                  {r.title}
                </span>}
                hint={<>
                  {r.skill && <span className="block font-mono truncate" style={{ color: "var(--text3)" }}>{r.skill}</span>}
                  {WHEN.find((w) => w.id === r.when)?.label}
                  {!r.builtIn && " · yours"}
                </>}
                control={<span className="flex items-center gap-2">
                  <button onClick={() => setEditing(r)} className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap"
                    style={{ border: edge(20), color: "var(--text2)" }}>Edit</button>
                  {r.builtIn && (
                    <button onClick={() => void reset(r)} title="Back to the wording it ships with"
                      className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap"
                      style={{ border: edge(20), color: "var(--text3)" }}>Reset</button>
                  )}
                  <button onClick={() => void drop(r)} title={r.builtIn ? "Take it out of the menu" : "Delete it"}
                    className="text-[12px] px-2.5 py-1 rounded-lg whitespace-nowrap"
                    style={{ border: edge(20), color: "var(--error)" }}>{r.builtIn ? "Hide" : "Delete"}</button>
                </span>}
              />
              {/* Under the row it belongs to, not at the foot of the page.
                  The editor used to render after the whole list, so pressing
                  Edit on the first prompt appeared to do nothing at all until
                  you scrolled past thirteen others to find it. */}
              {editing?.id === r.id && (
                <Editor r={editing} skills={skills} presets={[]}
                  onChange={setEditing} onSave={save} onCancel={() => setEditing(null)} />
              )}
              </Fragment>
            ))}
            {!rows.length && (
              <div className="py-1.5 text-[12px]" style={{ color: "var(--text4)" }}>Nothing here — the built-ins were hidden.</div>
            )}
            {!editing && (
              <div className="py-1.5">
                <button onClick={() => setEditing(blank(g.id))} className="text-[12px] px-2.5 py-1 rounded-lg"
                  style={{ border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)", color: "var(--text)" }}>
                  ＋ New prompt in {g.label.toLowerCase()}
                </button>
              </div>
            )}
            {editing && !editing.id && editing.group === g.id && (
              <Editor r={editing} skills={skills} presets={list.filter((x) => x.builtIn)}
                onChange={setEditing} onSave={save} onCancel={() => setEditing(null)} />
            )}
          </div>
        );
      })}

      {!hidden && (
        <div className="py-2 text-[12px]" style={{ color: "var(--text4)" }}>
          Every built-in is hidden. Reset one from the list, or write your own.
        </div>
      )}

    </Wrap>
  );
}

/** The shape SettingsModal's Section renders, written out rather than imported
 *  because SettingsModal imports this file. */
function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="pb-5 agx-settings-section"><div className="agx-settings-rows">{children}</div></div>;
}

function Editor({ r, skills, presets, onChange, onSave, onCancel }: {
  r: ReviewRecipe; skills: SkillInfo[]; presets: ReviewRecipe[];
  onChange: (r: ReviewRecipe) => void; onSave: (r: ReviewRecipe) => void; onCancel: () => void;
}) {
  const set = (patch: Partial<ReviewRecipe>) => onChange({ ...r, ...patch });
  /* Bring it into view and put the cursor in it. Even directly under its row,
     an editor that opens below the fold is an editor somebody thinks did not
     open — which is exactly how this started. `nearest` rather than `center`:
     if it is already on screen, nothing should move. */
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    first.current?.focus();
  }, []);
  const inp = "w-full text-[11.5px] px-2 py-1.5 rounded-lg outline-none";
  const style = { background: "var(--bg2)", border: edge(22), color: "var(--text)" };

  /* Skills whose name suggests they belong on a pull request go first: this
     list is 60 entries on a real machine and the four that matter here are
     never the four at the top alphabetically. */
  const ordered = useMemo(() => {
    const score = (s: SkillInfo) => (/\b(pr|review|pull)\b|pr-|review/i.test(`${s.name} ${s.category}`) ? 0 : 1);
    return [...skills].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
  }, [skills]);
  const chosen = ordered.find((s) => r.skill?.slice(1).split(/\s/)[0] === s.name);

  return (
    <div ref={box} className="rounded-xl p-3 flex flex-col gap-2.5 my-2" style={{ border: edge(28), background: "color-mix(in srgb, var(--bg3) 25%, transparent)" }}>
      <div className="flex gap-2 flex-wrap items-end">
        <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>Title — what the menu shows</span>
          <input ref={first} value={r.title} onChange={(e) => set({ title: e.target.value })} placeholder="What changed since my review"
            className={inp} style={style} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>Group</span>
          <select value={r.group} onChange={(e) => set({ group: e.target.value as ReviewRecipeGroup })}
            className="text-[11.5px] px-2 py-1.5 rounded-lg" style={style}>
            {GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>Suggest it</span>
        <select value={r.when} onChange={(e) => set({ when: e.target.value as ReviewRecipeWhen })}
          className="text-[11.5px] px-2 py-1.5 rounded-lg" style={style}>
          {WHEN.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
        </select>
      </label>

      {/* The skill, in two halves: which one, and what to pass it. Split
          because the arguments are where the placeholders go and a single
          text box made people type the slash and the name by hand every
          time — with the name being the half the machine already knows. */}
      <div className="flex gap-2 flex-wrap items-end">
        <label className="flex flex-col gap-1 min-w-[200px]">
          <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>Run a skill (optional)</span>
          <select value={chosen?.name ?? ""} className="text-[11.5px] px-2 py-1.5 rounded-lg" style={style}
            onChange={(e) => {
              const name = e.target.value;
              if (!name) { set({ skill: "" }); return; }
              const rest = r.skill?.split(/\s+/).slice(1).join(" ") ?? "";
              set({ skill: `/${name}${rest ? ` ${rest}` : ""}` });
            }}>
            <option value="">— none, just the prompt —</option>
            {ordered.map((s) => <option key={s.path} value={s.name}>/{s.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>
            Arguments {chosen?.argument_hint ? <span style={{ textTransform: "none", letterSpacing: 0 }}>· {chosen.argument_hint}</span> : null}
          </span>
          <input value={r.skill?.split(/\s+/).slice(1).join(" ") ?? ""}
            disabled={!chosen}
            placeholder={chosen?.argument_hint ?? "{number}"}
            onChange={(e) => set({ skill: `/${chosen?.name ?? ""}${e.target.value ? ` ${e.target.value}` : ""}` })}
            className={`${inp} font-mono`} style={{ ...style, opacity: chosen ? 1 : 0.5 }} />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>
          The prompt{r.skill ? " — sent after the skill line, as context" : ""}
        </span>
        <textarea value={r.body} onChange={(e) => set({ body: e.target.value })}
          rows={Math.min(24, Math.max(8, r.body.split("\n").length + 1))} spellCheck={false}
          placeholder={"Pull request #{number} of {repo}.\n\nRead-only: change nothing…"}
          className={`${inp} font-mono`} style={{ ...style, resize: "vertical" }} />
      </label>

      <div className="flex flex-wrap gap-1">
        {TOKENS.map(([tok, what]) => (
          <button key={tok} title={what} onClick={() => set({ body: `${r.body}${tok}` })}
            className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ border: edge(20), color: "var(--text3)" }}>{tok}</button>
        ))}
      </div>

      {/* Starting from one that exists beats starting from an empty box: the
          built-ins are the worked examples, and copying one is how somebody
          gets a prompt of their own that is any good. */}
      {!r.id && !!presets.length && (
        <label className="flex flex-col gap-1">
          <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)" }}>Or start from one of these</span>
          <select value="" className="text-[11.5px] px-2 py-1.5 rounded-lg" style={style}
            onChange={(e) => {
              const p = presets.find((x) => x.id === e.target.value);
              if (p) set({ title: `${p.title} (mine)`, body: p.body, skill: p.skill, group: p.group, when: p.when });
            }}>
            <option value="">— empty —</option>
            {presets.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </label>
      )}

      <div className="flex gap-2 pt-0.5">
        <button onClick={() => onSave(r)} className="text-[12px] px-3 py-1.5 rounded-lg"
          style={{ border: "1px solid color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text)" }}>
          Save
        </button>
        <button onClick={onCancel} className="text-[12px] px-3 py-1.5 rounded-lg"
          style={{ border: edge(20), color: "var(--text2)" }}>Cancel</button>
      </div>
    </div>
  );
}
