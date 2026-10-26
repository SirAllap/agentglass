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
import { SettingRow } from "./SettingRow.tsx";
import { EmptyState, FIELD_SELECT, Field, SettingsCard, SettingsForm, StatusBadge, helpIdFor } from "./SettingsKit.tsx";
import { EditorFoot, EditorPanel, ListBar, ListEditorSplit, ListPanel, NewButton, NothingSelected, differs } from "./SettingsListEditor.tsx";
import { ReviewIcon } from "./settingsNavIcons.tsx";
import { useReportHead, useReportSaving } from "./SettingsPageState.tsx";
import { previewParts, sizeWords } from "../lib/reviewPreview.ts";
import { ICON } from "../lib/iconSize.ts";
import { bumpReviewRecipes } from "./PrPanel.tsx";
import { Button, INPUT, INPUT_STYLE } from "./workspace/Chrome.tsx";
import { Select } from "./Select.tsx";
import { LaunchModeBadge, LaunchModeSelect } from "./LaunchMode.tsx";
import { SELECT_BOX } from "./SettingsKit.tsx";
import { Toggle } from "./SettingRow.tsx";
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
  /* The note on the card is written to a ClickUp card, so it is offered only
     where there is one. Unknown counts as connected: taskConnected fails open. */
  const [hasCards, setHasCards] = useState(true);
  /* New prompt is the page's one action, so it is in the header, where every page keeps its own. */
  useReportHead("review-prompts", { action: { label: "New prompt" } }, () => setEditing(blank("reviewing")));

  /* Which repositories review plugins may read the authoring session of. Nothing until the
     person adds one; the server holds the list and refuses every other repository. */
  const reads = useSessionReads();
  const allowed = reads?.repos ?? [];
  const pickable = (reads?.known ?? []).filter((r) => !allowed.includes(r));
  const setAllowed = (next: string[]) => { setting("plugins.sessionReads.repos").set(next.join(",")); };

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

  /* The first prompt is open when the page is: an editor with nothing in it, beside a list, reads as broken. */
  useEffect(() => {
    if (!editing && list) {
      const f = GROUPS.flatMap((g) => list.filter((r) => r.group === g.id && (hasCards || r.id !== "note-on-card")))[0];
      if (f) setEditing(f);
    }
  }, [list, editing, hasCards]);

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

  if (!list) return <SettingsCard title="Review prompts"><EmptyState>Reading your prompts…</EmptyState></SettingsCard>;

  const offered = (r: ReviewRecipe) => hasCards || r.id !== "note-on-card";
  const hidden = GROUPS.flatMap((g) => list.filter((r) => r.group === g.id && offered(r))).length;
  const ql = q.trim().toLowerCase();
  const matches = (r: ReviewRecipe) =>
    offered(r) && (kind === "all" || (kind === "builtin") === !!r.builtIn)
    && (!ql || `${r.title} ${r.body} ${r.skill ?? ""}`.toLowerCase().includes(ql));
  const visible = (r: ReviewRecipe) => matches(r) && (group === "all" || r.group === group);
  const count = list.filter(offered).length;
  const hiddenShown = hiddenList.filter((r) => offered(r) && matches(r) && (group === "all" || r.group === group));
  const saved = editing?.id ? list.find((x) => x.id === editing.id) ?? hiddenList.find((x) => x.id === editing.id) : undefined;
  const common = { skills, projects, busy, onChange: setEditing, onSave: save, onCancel: () => setEditing(saved ?? null) };
  const entry = (r: ReviewRecipe, g: ReviewRecipeGroup) => ({
    id: r.id, title: r.title,
    badge: g === "conflicts" ? undefined : <LaunchModeBadge mode={r.permissionMode} />,
    sub: <>
      {r.skill && <span className="t-mono">Skill {r.skill} · </span>}
      {g === "conflicts"
        ? `${r.repo ? `Only in ${projects.find((p) => p.root === r.repo)?.name ?? r.repo.split("/").pop()}` : "Every project"} · ${r.model && r.model !== "auto" ? r.model : "model from the conflict"}`
        : WHEN.find((w) => w.id === r.when)?.label}
      {!r.builtIn && " · yours"}
    </>,
  });

  return (
    <>
      {note && (
        <div role={note.ok ? "status" : "alert"} className="pb-4 text-[12px]"
          style={{ color: note.ok ? "var(--success-ink)" : "var(--error-ink)" }}>
          {note.text}
        </div>
      )}

      {/* One list, grouped, with the editor beside it. It was a card per group with the
          editor opening under the row, which made the page a scroll through fifteen
          prompts to find the form. The group filter is the seg; what a prompt is
          (built in, or yours) is the select, and a hidden built-in is one tap away. */}
      <ListBar<"all" | ReviewRecipeGroup> q={q} onQ={setQ} placeholder={`Filter ${count} prompts`} label="Filter review prompts"
        filters={[
          { id: "all", label: `All ${count}` },
          ...GROUPS.map((g) => ({ id: g.id, label: `${GROUP_PILL[g.id]} ${list.filter((r) => offered(r) && r.group === g.id).length}` })),
        ]}
        filter={group} onFilter={setGroup}>
        <Select title="Whose prompts" className={`${FIELD_SELECT} agx-le-kind`} value={kind} onChange={(v) => setKind(v as Kind)}
          options={[
            { value: "all", label: "Any kind" },
            { value: "builtin", label: `Built in ${list.filter((r) => offered(r) && r.builtIn).length}` },
            { value: "mine", label: `Yours ${list.filter((r) => offered(r) && !r.builtIn).length}` },
          ]} />
        {hiddenList.length > 0 && (
          <button type="button" className="agx-le-chipb" aria-pressed={showHidden} onClick={() => setShowHidden((v) => !v)}
            title={showHidden ? "Stop listing the hidden prompts" : "List the built-in prompts you hid, to offer them again"}>
            <StatusBadge tone={showHidden ? "info" : "off"}>{showHidden ? "Showing " : ""}{hiddenList.length} hidden</StatusBadge>
          </button>
        )}
      </ListBar>

      <ListEditorSplit
        list={<ListPanel selected={editing ? editing.id || null : null}
          onSelect={(id) => { const r = list.find((x) => x.id === id) ?? hiddenList.find((x) => x.id === id); if (r) setEditing(r); }}
          nothing="Nothing matches."
          blank={count === 0 && !hiddenList.length ? {
            icon: <ReviewIcon size={ICON.xl} />, title: "No review prompts",
            text: "Every built-in was hidden and none of yours is saved, so the review button has nothing to offer. Make one.",
            action: <NewButton onClick={() => setEditing(blank("reviewing"))}>New prompt</NewButton>,
          } : undefined}
          sections={[
            ...GROUPS.filter((g) => group === "all" || group === g.id).map((g) => ({
              id: g.id, title: g.label, onAdd: () => setEditing(blank(g.id)), addLabel: `New prompt in ${g.label}`,
              entries: list.filter((r) => r.group === g.id && visible(r)).map((r) => entry(r, g.id)),
              empty: !list.some((r) => r.group === g.id && offered(r)) ? "Nothing here: the built-ins were hidden." : undefined,
            })),
            ...(showHidden && hiddenShown.length ? [{
              id: "hidden", title: "Hidden",
              entries: hiddenShown.map((r) => ({ ...entry(r, r.group), sub: "Not offered on pull requests" })),
            }] : []),
          ]} />}
        editor={!editing ? (
          <NothingSelected noun="prompt" label="Review prompt" onNew={() => setEditing(blank("reviewing"))} />
        ) : (
          <Editor r={editing} saved={saved} presets={editing.id ? [] : list.filter((x) => x.builtIn && (x.group === "conflicts") === (editing.group === "conflicts"))} {...common}
            onReset={editing.builtIn && !editing.hidden ? () => void reset(editing) : undefined}
            onOffer={editing.hidden ? () => void offerAgain(editing) : undefined}
            onDrop={editing.id && !editing.hidden ? () => void drop(editing) : undefined} />
        )} />

      {/* Not a prompt, and here because this is the page about handing a pull request to a
          reviewer: what else the reviewer may be given. Off for every repository until added. */}
      <SettingsCard title="Review sessions"
        desc="A review plugin that asks for it can read a short summary of the agent session that wrote a pull request.">
        <SettingRow
          settingId="plugins.sessionReads.repos"
          label="Let review plugins read the authoring session"
          hint="Shared for the repositories below only, as a short summary"
          detail={{ summary: "Details", body: "The first request, the files the agent wrote, how many tools it used, and its closing summary — cut short, with home paths hidden. Never the transcript or any tool output. If anything in it looks like a secret, nothing is shared and the plugin is told why." }}
          control={<Select
            align="right"
            style={SELECT_BOX}
            value=""
            placeholder={pickable.length ? "Add a repository…" : "No other repository"}
            disabled={!pickable.length}
            onChange={(v) => { if (v && !allowed.includes(v)) setAllowed([...allowed, v]); }}
            options={pickable.map((r) => ({ value: r, label: r }))}
          />} />
        {allowed.map((r) => (
          <Toggle key={r} on label={r} hint="Allowed. Turn off to stop sharing from this repository."
            onClick={() => setAllowed(allowed.filter((x) => x !== r))} />
        ))}
        {!allowed.length && <EmptyState>No repository is shared. Review plugins are told it is not allowed.</EmptyState>}
      </SettingsCard>

      {!hidden && (
        <div className="pb-4 text-[12px]" style={{ color: "var(--text4)" }}>
          Every built-in is hidden. Reset one from the list, or write your own.
        </div>
      )}
    </>
  );
}

/**
 * The editor: the fields on one side, the prompt on the other (the prompt
 * first when the card is narrow), and one primary Save in the foot. What undoes
 * the prompt (Reset, Hide or Delete) is at the far end of the head, apart from
 * Save and Cancel.
 */
function Editor({ r, saved, skills, projects, presets, busy, onChange, onSave, onCancel, onReset, onOffer, onDrop }: {
  r: ReviewRecipe; saved?: ReviewRecipe; skills: SkillInfo[]; projects: { root: string; name: string }[]; presets: ReviewRecipe[]; busy: boolean;
  onChange: (r: ReviewRecipe) => void; onSave: (r: ReviewRecipe) => void; onCancel: () => void;
  onReset?: () => void; onOffer?: () => void; onDrop?: () => void;
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
  const parts = useMemo(() => previewParts(r.body, r.group), [r.body, r.group]);
  /* The preview is a glance, not a second editor: the first 600 characters of the filled-in prompt. */
  const shown = useMemo(() => {
    let left = PREVIEW_CHARS;
    const out: typeof parts = [];
    for (const p of parts) { if (left <= 0) break; out.push(p.text.length > left ? { ...p, text: p.text.slice(0, left) } : p); left -= p.text.length; }
    return out;
  }, [parts]);

  return (
    <EditorPanel label="Review prompt" title={r.title || "New prompt"}
      chips={[
        ...(r.id && r.builtIn ? [{ tone: "off" as const, text: "Built in" }] : []),
        ...(r.edited ? [{ tone: "warn" as const, text: "Edited" }] : []),
        ...(!r.id ? [{ tone: "info" as const, text: "Draft" }] : []),
      ]}
      actions={<>
        {onOffer && <Button tone="primary" onClick={onOffer} title="Put it back in the review menu">Offer again</Button>}
        {onDrop && (
          <Button tone={r.builtIn ? "plain" : "danger"} onClick={onDrop} title={r.builtIn ? "Take it out of the menu" : "Delete it"}>
            {r.builtIn ? "Hide" : "Delete"}
          </Button>
        )}
        {onReset && <Button tone="danger" onClick={onReset} title="Back to the wording it ships with">Reset to built-in</Button>}
      </>}>
        <SettingsForm label={r.id ? `Edit ${r.title}` : "New prompt"} onSubmit={() => onSave(r)}>
          <div className="agx-le-eb">
          <div className="agx-le-ef">
          <Field label="Title" htmlFor={f("title")} help="What the menu shows.">
            <input id={f("title")} value={r.title} onChange={(e) => set({ title: e.target.value })}
              aria-describedby={helpIdFor(f("title"))} placeholder="What changed since my review"
              className={INPUT} style={INPUT_STYLE} />
          </Field>
          <Field label="Group" htmlFor={f("group")}>
            <Select title="Group" className={FIELD_SELECT} value={r.group} onChange={(v) => set({ group: v as ReviewRecipeGroup })}
              options={GROUPS.map((g) => ({ value: g.id, label: g.label }))} />
          </Field>

          {r.group === "conflicts" ? (
            <>
              <Field label="Project" htmlFor={f("repo")} help={r.builtIn ? "Choosing one saves a copy for it." : undefined}>
                <Select title="Project" className={FIELD_SELECT} value={r.repo ?? ""} onChange={(v) => set({ repo: v || undefined })}
                  options={[
                    { value: "", label: "Every project" },
                    ...projects.map((p) => ({ value: p.root, label: p.name })),
                    /* A project that is no longer listed (moved, hidden, the list did
                       not load) must not read as "every project" while the old path
                       is still what gets saved. */
                    ...(r.repo && !projects.some((p) => p.root === r.repo) ? [{ value: r.repo, label: `${r.repo.split("/").pop()} (not found)` }] : []),
                  ]} />
              </Field>
              <Field label="Model" htmlFor={f("model")}>
                <Select title="Model" className={FIELD_SELECT} value={r.model ?? "auto"} onChange={(v) => set({ model: v as ConflictModel })}
                  options={MODELS.map(([id, label]) => ({ value: id, label }))} />
              </Field>
              <Field label="Effort" htmlFor={f("effort")}>
                <Select title="Effort" className={FIELD_SELECT} value={r.effort ?? "auto"} onChange={(v) => set({ effort: v as ConflictEffort })}
                  options={EFFORTS.map(([id, label]) => ({ value: id, label }))} />
              </Field>
            </>
          ) : (
            <Field label="Suggest it" htmlFor={f("when")} help="Pick when it is offered on a PR. Only decides what is suggested first: every prompt is always in the menu.">
              <Select title="Suggest it" className={FIELD_SELECT} value={r.when} onChange={(v) => set({ when: v as ReviewRecipeWhen })}
                options={WHEN.map((w) => ({ value: w.id, label: w.label }))} />
            </Field>
          )}

          {/* The skill, in two halves: which one, and what to pass it. Split
              because the arguments are where the placeholders go and a single
              text box made people type the slash and the name by hand every
              time — with the name being the half the machine already knows. */}
          <Field label="Run a skill" htmlFor={f("skill")} help="Optional.">
            <Select title="Run a skill" className={FIELD_SELECT} value={chosen?.name ?? ""}
              onChange={(name) => {
                if (!name) { set({ skill: "" }); return; }
                const rest = r.skill?.split(/\s+/).slice(1).join(" ") ?? "";
                set({ skill: `/${name}${rest ? ` ${rest}` : ""}` });
              }}
              options={[{ value: "", label: "None, just the prompt" }, ...ordered.map((s) => ({ value: s.name, label: `/${s.name}` }))]} />
          </Field>

          {/* Not on a conflict prompt: that tab is opened by the merge view with
              its own model choice, and the field would be one that does nothing. */}
          {r.group !== "conflicts" && (
            <Field label="Permission mode" htmlFor={f("mode")} help="How the terminal this prompt opens asks before a tool runs.">
              <LaunchModeSelect value={r.permissionMode} onChange={(m) => set({ permissionMode: m })} />
            </Field>
          )}

          <Field label="Arguments" htmlFor={f("args")} help={chosen?.argument_hint}>
            <input id={f("args")} value={r.skill?.split(/\s+/).slice(1).join(" ") ?? ""}
              disabled={!chosen}
              aria-describedby={chosen?.argument_hint ? helpIdFor(f("args")) : undefined}
              placeholder={chosen?.argument_hint ?? "{number}"}
              onChange={(e) => set({ skill: `/${chosen?.name ?? ""}${e.target.value ? ` ${e.target.value}` : ""}` })}
              className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, opacity: chosen ? 1 : 0.5 }} />
          </Field>

          {/* Starting from one that exists beats starting from an empty box: the
              built-ins are the worked examples, and copying one is how somebody
              gets a prompt of their own that is any good. */}
          {!r.id && !!presets.length && (
            <Field label="Or start from one of these" htmlFor={f("preset")}>
              <Select title="Or start from one of these" className={FIELD_SELECT} value="" placeholder="Empty"
                onChange={(v) => {
                  const p = presets.find((x) => x.id === v);
                  if (p) set({ title: `${p.title} (mine)`, body: p.body, skill: p.skill, group: p.group, when: p.when, model: p.model, effort: p.effort });
                }}
                options={presets.map((p) => ({ value: p.id, label: p.title }))} />
            </Field>
          )}
          </div>

          <div className="agx-le-ep">
            <label htmlFor={f("body")} className="agx-le-pl">The prompt</label>
            <div className="agx-le-vars" role="group" aria-label="Placeholders">
              <span>Insert:</span>
              {tokens.map(([tok, what]) => (
                <button key={tok} type="button" title={what} className="t-mono" onClick={() => set({ body: `${r.body}${tok}` })}>{tok}</button>
              ))}
              <span className="flex-1" />
              <span className="agx-le-count">{sizeWords(r.body)}</span>
            </div>
            <textarea id={f("body")} value={r.body} onChange={(e) => set({ body: e.target.value })}
              aria-describedby={r.skill ? helpIdFor(f("body")) : undefined}
              spellCheck={false}
              placeholder={"Pull request #{number} of {repo}.\n\nRead-only: change nothing…"}
              className="agx-le-ta t-mono" style={INPUT_STYLE} />
            {r.skill && <p id={helpIdFor(f("body"))} className="agx-le-help">Sent after the skill line, as context.</p>}
            <div className="agx-le-pv" aria-label="Preview with a demo pull request">
              <b>Preview</b> · Pull request #1042 of acme/orbit.{" "}
              {parts.length
                ? <>{shown.map((p, i) => (p.filled ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}{parts.reduce((n, p) => n + p.text.length, 0) > PREVIEW_CHARS ? "…" : ""}</>
                : <span className="agx-le-pv-none">Nothing to preview yet.</span>}
            </div>
          </div>
          </div>
          <EditorFoot dirty={!r.id || differs(r, saved)} canSave noun="prompt" onCancel={onCancel} busy={busy} />
        </SettingsForm>
    </EditorPanel>
  );
}
