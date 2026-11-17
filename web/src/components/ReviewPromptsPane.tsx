/*
 * The review menu ("Review with <engine>"), as a page you can edit.
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
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { taskConnected } from "../lib/taskConnected.ts";
import { CONFLICT_EFFORTS, CONFLICT_MODELS, type ConflictEffort, type ConflictModel } from "../../../shared/types.ts";
import type { ReviewRecipe, ReviewRecipeGroup, ReviewRecipeWhen, SkillInfo } from "../../../shared/types.ts";
import { FormInput } from "./settings/shell/FormInput.tsx";
import { Section } from "./settings/shell/Section.tsx";
import { SettingRow } from "./settings/shell/SettingRow.tsx";
import { DangerAction, GroupActions, pushSaveToast } from "./settings/save/index.ts";
import { FIELD_SELECT } from "./SettingsKit.tsx";
import { differs } from "./SettingsListEditor.tsx";
import { useReportHead, useReportSaving } from "./SettingsPageState.tsx";
import { previewParts, sizeWords } from "../lib/reviewPreview.ts";
import { bumpReviewRecipes } from "./PrPanel.tsx";
import { Button, INPUT, INPUT_STYLE, LINE, Segmented } from "./workspace/Chrome.tsx";
import { Select } from "./Select.tsx";
import { BoardSkeleton } from "./tasks/BoardState.tsx";
import { LaunchModeSelect } from "./LaunchMode.tsx";
import { SELECT_BOX } from "./SettingsKit.tsx";
import { setting } from "../lib/settingsRegistry.ts";
import { useSessionReads } from "../lib/sessionReads.ts";

const GROUPS: { id: ReviewRecipeGroup; label: string; what: string }[] = [
  { id: "reviewing", label: "Reviewing", what: "Somebody else's pull request." },
  { id: "focused", label: "One thing only", what: "A single question, asked well — risk, tests, data, security." },
  { id: "mine", label: "Your pull request", what: "The ones where the work is yours." },
  /* Not a review, and here anyway: what you say to a colleague is as personal
     as how you ask for one, it must survive an update of this app, and it must
     not live in its repository. Same file, same editor, same Reset. It is not
     offered in the review menu — that menu lists the three groups
     above by name — it is what the Ping button sends. */
  { id: "telling", label: "Telling somebody", what: "Asking for a review in chat, rather than reading one." },
  /* Also not a review: what "Send to terminal" says on a pull
     request that conflicts. One per project when a project needs its own
     ("regenerate the lockfile, never merge it by hand"), and the model it opens
     on is chosen from the conflict unless you pin one here. */
  { id: "conflicts", label: "Merge conflicts", what: "What your agent is told when you send it a conflict — for every project, or one." },
];

/** What each situation means, in the words the menu would use. Shown beside the
 *  field, because "asked" on its own is a word from a database. */
const WHEN: { id: ReviewRecipeWhen; label: string }[] = [
  { id: "any", label: "Always available, never on its own" },
  { id: "asked", label: "When your review is requested" },
  { id: "reviewed", label: "When it has moved since your review" },
  { id: "card", label: "When it carries a card id" },
  { id: "mine", label: "When it is yours" },
  { id: "mine-changes", label: "When changes were requested" },
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
  ["{cardUrl}", "that card's page"],
  ["{who}", "who the message is for"],
  ["{note}", "what you typed in the box"],
];

/** What a conflict prompt can say. `{files}` is a line per conflicted file. */
const CONFLICT_TOKENS: [string, string][] = [
  ["{number}", "the pull request number — empty in the Git panel"],
  ["{repo}", "owner/name — empty in the Git panel"],
  ["{branch}", "the head branch"],
  ["{base}", "what it merges into"],
  ["{files}", "the conflicted files, a line each"],
  ["{worktree}", "where the conflict is"],
  ["{title}", "the pull request title — empty in the Git panel"],
];

const AUTO = "Pick from the conflict";
const cap = (v: string) => (v === "auto" ? AUTO : v[0]!.toUpperCase() + v.slice(1));
const MODELS = CONFLICT_MODELS.map((v) => [v, cap(v)] as const);
const EFFORTS = CONFLICT_EFFORTS.map((v) => [v, cap(v)] as const);

/** The group filter's words: shorter than the headings, so six of them fit one bar. */
const GROUP_PILL: Record<ReviewRecipeGroup, string> = { reviewing: "Reviewing", focused: "One thing", mine: "Your PR", telling: "Telling", conflicts: "Conflicts" };

const blank = (group: ReviewRecipeGroup): ReviewRecipe => ({
  id: "", title: "", body: "", group, when: "any",
});

type Kind = "all" | "builtin" | "mine";
const PREVIEW_CHARS = 600;

export function ReviewPromptsPane({ open }: { open: boolean }) {
  const [list, setList] = useState<ReviewRecipe[] | null>(null);
  const [hiddenList, setHiddenList] = useState<ReviewRecipe[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [editing, setEditing] = useState<ReviewRecipe | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [projects, setProjects] = useState<{ root: string; name: string }[]>([]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useReportSaving("review-prompts", busy);
  /* New prompt is the page header's one action; the empty state below keeps its own. */
  useReportHead("review-prompts", list && !editing ? { action: { label: "New prompt" } } : null, () => setEditing(blank("reviewing")));
  /* The note on the card is written to a ClickUp card, so it is offered only
     where there is one. Unknown counts as connected: taskConnected fails open. */
  const [hasCards, setHasCards] = useState(true);

  /* Which repositories review plugins may read the authoring session of. Nothing until the
     person adds one; the server holds the list and refuses every other repository. */
  const reads = useSessionReads();
  const allowed = reads?.repos ?? [];
  const pickable = (reads?.known ?? []).filter((r) => !allowed.includes(r));
  const setAllowed = (next: string[]) => {
    const before = allowed;
    setting("plugins.sessionReads.repos").set(next.join(","));
    pushSaveToast("Saved", () => { setting("plugins.sessionReads.repos").set(before.join(",")); });
  };

  const load = useCallback(async () => {
    try {
      const r = await api.prPrompts();
      setList(r.recipes ?? []);
      setHiddenList(r.hidden ?? []);
      return r.recipes ?? [];
    } catch { setList([]); return []; }
  }, []);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<"all" | ReviewRecipeGroup>("all");
  const [kind, setKind] = useState<Kind>("all");
  useEffect(() => {
    if (!open) return;
    void load();
    void taskConnected().then((c) => setHasCards(c.clickup));
    // Skills, for the picker. A failure here is not an error on this page: it
    // only means the skill field falls back to being a text box.
    api.skills().then((r) => setSkills(r.skills ?? [])).catch(() => {});
    // The projects a conflict prompt can be written for: main checkouts only,
    // since a worktree is the same project under another name.
    api.gitRepos().then((r) => setProjects((r.repos ?? []).filter((x) => !x.worktreeOf).map((x) => ({ root: x.root, name: x.name })))).catch(() => {});
  }, [open, load]);

  const after = async (text: string, ok = true, keep?: string) => {
    setNote({ ok, text });
    const fresh = await load();
    setEditing(keep ? fresh.find((x) => x.id === keep) ?? null : null);
    // The menu holds this list in a module cache so pressing the button does
    // not cost a round trip. This is the one event that invalidates it.
    bumpReviewRecipes();
  };

  const save = async (r: ReviewRecipe) => {
    setBusy(true);
    try {
      const res = await api.prPromptSave(r);
      if (!res.ok) { setNote({ ok: false, text: res.error ?? "That did not save" }); return; }
      await after(`${r.title} saved`, true, r.id || undefined);
    } finally { setBusy(false); }
  };
  const drop = async (r: ReviewRecipe) => {
    await api.prPromptRemove(r.id).catch(() => {});
    await after(r.builtIn ? `${r.title} hidden. Offer it again from the hidden list.` : `${r.title} removed`);
  };
  const reset = async (r: ReviewRecipe) => {
    await api.prPromptReset(r.id).catch(() => {});
    await after(`${r.title} back to the wording it ships with`, true, r.id);
  };
  /* A hidden built-in is brought back the way it ships: the same call as Reset, which also lifts the tombstone. */
  const offerAgain = async (r: ReviewRecipe) => {
    await api.prPromptReset(r.id).catch(() => {});
    await after(`${r.title} is offered on pull requests again`, true, r.id);
  };

  if (!list) return <Section id="review" title="Review sessions"><BoardSkeleton label="Reading your prompts…" widths={[70, 50]} dots={false} /></Section>;

  const offered = (r: ReviewRecipe) => hasCards || r.id !== "note-on-card";
  const ql = q.trim().toLowerCase();
  const matches = (r: ReviewRecipe) =>
    offered(r) && (kind === "all" || (kind === "builtin") === !!r.builtIn)
    && (!ql || `${r.title} ${r.body} ${r.skill ?? ""}`.toLowerCase().includes(ql));
  const visible = (r: ReviewRecipe) => matches(r) && (group === "all" || r.group === group);
  const count = list.filter(offered).length;
  const hiddenShown = hiddenList.filter((r) => offered(r) && matches(r) && (group === "all" || r.group === group));
  const saved = editing?.id ? list.find((x) => x.id === editing.id) ?? hiddenList.find((x) => x.id === editing.id) : undefined;
  const common = { skills, projects, busy, onChange: setEditing, onSave: save, onCancel: () => setEditing(saved ?? null) };
  const helpOf = (r: ReviewRecipe, g: ReviewRecipeGroup) => [
    r.skill ? `Skill ${r.skill}` : "",
    g === "conflicts"
      ? `${r.repo ? `Only in ${projects.find((p) => p.root === r.repo)?.name ?? r.repo.split("/").pop()}` : "Every project"}, ${r.model && r.model !== "auto" ? r.model : "model from the conflict"}`
      : WHEN.find((w) => w.id === r.when)?.label ?? "",
    r.builtIn ? "" : "yours",
    r.edited ? "Edited" : "",
  ].filter(Boolean).join(". ") + ".";
  const promptRow = (r: ReviewRecipe, g: ReviewRecipeGroup, isHidden = false) => (
    <div key={`${isHidden ? "h" : "v"}-${r.id}`} data-prompt-id={r.id}>
      <SettingRow kind="control" label={r.title} help={isHidden ? "Not offered on pull requests." : helpOf(r, g)}
        control={<>
          <Button onClick={() => setEditing(r)}>Edit</Button>
          {isHidden && <Button onClick={() => void offerAgain(r)}>Offer again</Button>}
          {!isHidden && r.builtIn && r.edited && <DangerAction label="Reset to built-in" onConfirm={() => reset(r)} />}
          {!isHidden && r.builtIn && <Button onClick={() => void drop(r)}>Hide</Button>}
          {!isHidden && !r.builtIn && <DangerAction label="Delete" onConfirm={() => drop(r)} />}
        </>} />
    </div>
  );

  return (
    <>
      <Section id="review" title="Review sessions" intro="The prompts the review button offers on a pull request, and what a reviewer may read.">
        {count === 0 && !hiddenList.length && (
          <SettingRow kind="control" label="No review prompts" help="Every built-in was hidden. Write your own."
            control={<Button onClick={() => setEditing(blank("reviewing"))}>New prompt</Button>} />
        )}
        {count > 6 && (
          <SettingRow kind="control" label="Filter prompts" help={`Search ${count} prompts by title, text or skill.`}
            control={<>
              <FormInput aria-label="Search prompts" placeholder="Search prompts" value={q} onChange={(e) => setQ(e.target.value)} className={INPUT} style={{ ...INPUT_STYLE, width: 160 }} />
              <Select title="Group" className={FIELD_SELECT} value={group} onChange={(v) => setGroup(v as "all" | ReviewRecipeGroup)}
                options={[{ value: "all", label: `All ${count}` }, ...GROUPS.map((g) => ({ value: g.id, label: `${GROUP_PILL[g.id]} ${list.filter((r) => offered(r) && r.group === g.id).length}` }))]} />
              <Select title="Whose prompts" className={FIELD_SELECT} value={kind} onChange={(v) => setKind(v as Kind)}
                options={[
                  { value: "all", label: "Any kind" },
                  { value: "builtin", label: `Built in ${list.filter((r) => offered(r) && r.builtIn).length}` },
                  { value: "mine", label: `Yours ${list.filter((r) => offered(r) && !r.builtIn).length}` },
                ]} />
            </>} />
        )}
        {GROUPS.filter((g) => group === "all" || group === g.id).map((g) => {
          const rows = list.filter((r) => r.group === g.id && visible(r));
          return rows.length ? (
            <div key={g.id} data-prompt-group={g.id}>
              <div className="px-3 pt-2.5 pb-1 text-[11px] font-medium" style={{ color: "var(--text2)", borderTop: LINE }}>{g.label}</div>
              {rows.map((r) => promptRow(r, g.id))}
            </div>
          ) : null;
        })}
        {hiddenList.length > 0 && (
          <SettingRow kind="control" label="Hidden built-in prompts" help={showHidden ? `${hiddenList.length} hidden. Offer one again from its row.` : `${hiddenList.length} hidden from the review menu.`}
            control={<Button onClick={() => setShowHidden((v) => !v)}>{showHidden ? "Stop listing" : "List them"}</Button>} />
        )}
        {showHidden && hiddenShown.map((r) => promptRow(r, r.group, true))}
        {note && (
          <div role={note.ok ? "status" : "alert"} className="px-3 py-2 text-[12px]" style={{ color: note.ok ? "var(--success-ink)" : "var(--error-ink)" }}>{note.text}</div>
        )}
        <SettingRow kind="control" settingId="plugins.sessionReads.repos" label="Let review plugins read the authoring session"
          help="A short summary, for the repositories below only."
          control={<Select align="right" style={SELECT_BOX} value="" placeholder={pickable.length ? "Add a repository…" : "No other repository"}
            disabled={!pickable.length} onChange={(v) => { if (v && !allowed.includes(v)) setAllowed([...allowed, v]); }}
            options={pickable.map((r) => ({ value: r, label: r }))} />} />
        <div className="px-3 pb-2 text-[12px]" style={{ color: "var(--text2)" }}>
          What is shared: the first request, the files the agent wrote, how many tools it used, and its closing summary, cut short, with home paths hidden.
          Never the transcript or any tool output. If anything in it looks like a secret, nothing is shared.
        </div>
        {allowed.map((r) => (
          <SettingRow key={r} kind="control" label={r} help="Allowed. Stop sharing from this repository."
            control={<Button onClick={() => setAllowed(allowed.filter((x) => x !== r))}>Stop sharing</Button>} />
        ))}
        {!allowed.length && <div className="px-3 py-2 text-[12px]" style={{ color: "var(--text2)" }}>No repository is shared. Review plugins are told it is not allowed.</div>}
      </Section>
      {editing && (
        <ReviewPromptEditor r={editing} saved={saved} presets={editing.id ? [] : list.filter((x) => x.builtIn && (x.group === "conflicts") === (editing.group === "conflicts"))} {...common} />
      )}
    </>
  );
}

/** The editor: a section of rows (fields, then the prompt) and one primary Save. Hide, Delete and Reset are on the list row. */
function ReviewPromptEditor({ r, saved, skills, projects, presets, busy, onChange, onSave, onCancel }: {
  r: ReviewRecipe; saved?: ReviewRecipe; skills: SkillInfo[]; projects: { root: string; name: string }[]; presets: ReviewRecipe[]; busy: boolean;
  onChange: (r: ReviewRecipe) => void; onSave: (r: ReviewRecipe) => void; onCancel: () => void;
}) {
  const set = (patch: Partial<ReviewRecipe>) => onChange({ ...r, ...patch });
  const uid = useId();
  const f = (k: string) => `${uid}-${k}`;
  /* Skills whose name suggests they belong on a pull request go first: this
     list is 60 entries on a real machine and the four that matter here are
     never the four at the top alphabetically. */
  const ordered = useMemo(() => {
    const score = (s: SkillInfo) => (/\b(pr|review|pull)\b|pr-|review/i.test(`${s.name} ${s.category}`) ? 0 : 1);
    return [...skills].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
  }, [skills]);
  const chosen = ordered.find((s) => r.skill?.slice(1).split(/\s/)[0] === s.name);
  const tokens = r.group === "conflicts" ? CONFLICT_TOKENS : TOKENS;
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const parts = useMemo(() => previewParts(r.body, r.group), [r.body, r.group]);
  /* The preview is a glance, not a second editor: the first 600 characters of the filled-in prompt. */
  const shown = useMemo(() => {
    let left = PREVIEW_CHARS;
    const out: typeof parts = [];
    for (const p of parts) { if (left <= 0) break; out.push(p.text.length > left ? { ...p, text: p.text.slice(0, left) } : p); left -= p.text.length; }
    return out;
  }, [parts]);
  const wide = { minWidth: 260 };
  return (
    <Section id="review-edit" title={r.id ? `Edit ${r.title || "prompt"}` : "New prompt"}
      intro={[r.id && r.builtIn ? "Built in." : "", r.edited ? "Edited." : "", !r.id ? "Draft." : ""].filter(Boolean).join(" ") || undefined}>
      <SettingRow kind="control" label="View" help="Edit the prompt, or see it filled in for a demo pull request."
        control={<Segmented label="Edit or preview" value={tab} onChange={setTab} options={[{ id: "edit", label: "Edit" }, { id: "preview", label: "Preview" }]} />} />
      {tab === "preview" ? (
        <div className="agx-le-pv px-3 py-2.5" aria-label="Preview with a demo pull request" style={{ borderTop: LINE }}>
          <b>Preview</b> · Pull request #1042 of acme/orbit.{" "}
          {parts.length
            ? <>{shown.map((p, i) => (p.filled ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}{parts.reduce((n, p) => n + p.text.length, 0) > PREVIEW_CHARS ? "…" : ""}</>
            : <span className="agx-le-pv-none">Nothing to preview yet.</span>}
        </div>
      ) : (
        <>
          <SettingRow kind="control" label="Title" help="What the menu shows."
            control={<FormInput id={f("title")} aria-label="Title" value={r.title} onChange={(e) => set({ title: e.target.value })} placeholder="What changed since my review"
              className={INPUT} style={{ ...INPUT_STYLE, ...wide }} />} />
          <SettingRow kind="control" label="Group" help="Where the menu lists it."
            control={<Select title="Group" className={FIELD_SELECT} value={r.group} onChange={(v) => set({ group: v as ReviewRecipeGroup })}
              options={GROUPS.map((g) => ({ value: g.id, label: g.label }))} />} />
          {r.group === "conflicts" ? (
            <>
              <SettingRow kind="control" label="Project" help={r.builtIn ? "Choosing one saves a copy for it." : "The project this prompt is for."}
                control={<Select title="Project" className={FIELD_SELECT} value={r.repo ?? ""} onChange={(v) => set({ repo: v || undefined })}
                  options={[
                    { value: "", label: "Every project" },
                    ...projects.map((p) => ({ value: p.root, label: p.name })),
                    /* A project that is no longer listed must not read as "every project" while the old path is still what gets saved. */
                    ...(r.repo && !projects.some((p) => p.root === r.repo) ? [{ value: r.repo, label: `${r.repo.split("/").pop()} (not found)` }] : []),
                  ]} />} />
              <SettingRow kind="control" label="Model" help="The model the conflict tab opens on."
                control={<Select title="Model" className={FIELD_SELECT} value={r.model ?? "auto"} onChange={(v) => set({ model: v as ConflictModel })}
                  options={MODELS.map(([id, label]) => ({ value: id, label }))} />} />
              <SettingRow kind="control" label="Effort" help="How hard it thinks before it answers."
                control={<Select title="Effort" className={FIELD_SELECT} value={r.effort ?? "auto"} onChange={(v) => set({ effort: v as ConflictEffort })}
                  options={EFFORTS.map(([id, label]) => ({ value: id, label }))} />} />
            </>
          ) : (
            <SettingRow kind="control" label="Suggest it" help="Decides what is suggested first. Every prompt stays in the menu."
              control={<Select title="Suggest it" className={FIELD_SELECT} value={r.when} onChange={(v) => set({ when: v as ReviewRecipeWhen })}
                options={WHEN.map((w) => ({ value: w.id, label: w.label }))} />} />
          )}
          <SettingRow kind="control" label="Run a skill" help="Optional. Runs before the prompt."
            control={<Select title="Run a skill" className={FIELD_SELECT} value={chosen?.name ?? ""}
              onChange={(name) => {
                if (!name) { set({ skill: "" }); return; }
                const rest = r.skill?.split(/\s+/).slice(1).join(" ") ?? "";
                set({ skill: `/${name}${rest ? ` ${rest}` : ""}` });
              }}
              options={[{ value: "", label: "None, just the prompt" }, ...ordered.map((s) => ({ value: s.name, label: `/${s.name}` }))]} />} />
          {/* Not on a conflict prompt: that tab is opened by the merge view with its own model choice. */}
          {r.group !== "conflicts" && (
            <SettingRow kind="control" label="Permission mode" help="How the terminal it opens asks before a tool runs."
              control={<LaunchModeSelect value={r.permissionMode} onChange={(m) => set({ permissionMode: m })} />} />
          )}
          <SettingRow kind="control" label="Arguments" help={chosen?.argument_hint ?? "What to pass the skill."}
            control={<FormInput id={f("args")} aria-label="Arguments" value={r.skill?.split(/\s+/).slice(1).join(" ") ?? ""} disabled={!chosen}
              placeholder={chosen?.argument_hint ?? "{number}"}
              onChange={(e) => set({ skill: `/${chosen?.name ?? ""}${e.target.value ? ` ${e.target.value}` : ""}` })}
              className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, opacity: chosen ? 1 : 0.5 }} />} />
          {!r.id && !!presets.length && (
            <SettingRow kind="control" label="Start from one of these" help="Copy a built-in, then change it."
              control={<Select title="Or start from one of these" className={FIELD_SELECT} value="" placeholder="Empty"
                onChange={(v) => {
                  const p = presets.find((x) => x.id === v);
                  if (p) set({ title: `${p.title} (mine)`, body: p.body, skill: p.skill, group: p.group, when: p.when, model: p.model, effort: p.effort });
                }}
                options={presets.map((p) => ({ value: p.id, label: p.title }))} />} />
          )}
          <SettingRow kind="control" label="The prompt" help={`${sizeWords(r.body)}. ${r.skill ? "Sent after the skill line, as context." : "Placeholders are filled in when it runs."}`}
            control={<textarea id={f("body")} aria-label="The prompt" value={r.body} onChange={(e) => set({ body: e.target.value })} spellCheck={false} rows={8}
              placeholder={"Pull request #{number} of {repo}.\n\nRead-only: change nothing…"}
              className="agx-le-ta t-mono" style={{ ...INPUT_STYLE, ...wide }} />} />
          <div className="agx-le-vars px-3 pb-2.5" role="group" aria-label="Placeholders">
            <span>Insert:</span>
            {tokens.map(([tok, what]) => (
              <button key={tok} type="button" data-tip={what} className="t-mono" onClick={() => set({ body: `${r.body}${tok}` })}>{tok}</button>
            ))}
          </div>
        </>
      )}
      <div className="px-3 py-2.5" style={{ borderTop: LINE }}>
        <GroupActions primary="Save prompt" dirty={!r.id || differs(r, saved)} busy={busy} onPrimary={() => onSave(r)} onCancel={onCancel} />
      </div>
    </Section>
  );
}
