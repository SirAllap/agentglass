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
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { taskConnected } from "../lib/taskConnected.ts";
import { CONFLICT_EFFORTS, CONFLICT_MODELS, type ConflictEffort, type ConflictModel } from "../../../shared/types.ts";
import type { ReviewRecipe, ReviewRecipeGroup, ReviewRecipeWhen, SkillInfo } from "../../../shared/types.ts";
import { SettingRow } from "./SettingRow.tsx";
import { EmptyState, Field, SettingsCard, SettingsForm, helpIdFor } from "./SettingsKit.tsx";
import { bumpReviewRecipes } from "./PrPanel.tsx";
import { IconLabel, PlusIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
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
     offered in the "Review with Claude" menu — that menu lists the three groups
     above by name — it is what the Ping button sends. */
  { id: "telling", label: "Telling somebody", what: "Asking for a review in chat, rather than reading one." },
  /* Also not a review: what "Hand to Claude in a terminal" says on a pull
     request that conflicts. One per project when a project needs its own
     ("regenerate the lockfile, never merge it by hand"), and the model it opens
     on is chosen from the conflict unless you pin one here. */
  { id: "conflicts", label: "Merge conflicts", what: "What Claude is told when you hand it a conflict — for every project, or one." },
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

const blank = (group: ReviewRecipeGroup): ReviewRecipe => ({
  id: "", title: "", body: "", group, when: "any",
});

export function ReviewPromptsPane({ open }: { open: boolean }) {
  const [list, setList] = useState<ReviewRecipe[] | null>(null);
  const [editing, setEditing] = useState<ReviewRecipe | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [projects, setProjects] = useState<{ root: string; name: string }[]>([]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  /* The note on the card is written to a ClickUp card, so it is offered only
     where there is one. Unknown counts as connected: taskConnected fails open. */
  const [hasCards, setHasCards] = useState(true);

  /* Which repositories review plugins may read the authoring session of. Nothing until the
     person adds one; the server holds the list and refuses every other repository. */
  const reads = useSessionReads();
  const allowed = reads?.repos ?? [];
  const pickable = (reads?.known ?? []).filter((r) => !allowed.includes(r));
  const setAllowed = (next: string[]) => { setting("plugins.sessionReads.repos").set(next.join(",")); };

  const load = useCallback(async () => {
    try { const r = await api.prPrompts(); setList(r.recipes ?? []); } catch { setList([]); }
  }, []);
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

  if (!list) return <SettingsCard title="Review prompts"><EmptyState>Reading your prompts…</EmptyState></SettingsCard>;

  const offered = (r: ReviewRecipe) => hasCards || r.id !== "note-on-card";
  const hidden = GROUPS.flatMap((g) => list.filter((r) => r.group === g.id && offered(r))).length;

  return (
    <>
      {/* Four groups, four cards. It was ONE card holding fifteen prompts with
          a 9.5px tracked sub-label between them, so the page read as a single
          list you had to scan end to end — and the four names that would have
          told you where to stop were the smallest type on it. Each group
          already carries the two lines a heading needs; they just were not
          being used as one. */}
      <p className="text-[12.5px] m-0 pb-4" style={{ color: "var(--text3)" }}>
        What the Review with Claude button offers on a pull request. The one that fits the pull request in front of you is
        suggested at the top; the rest are always in the menu, because GitHub's fields describe what somebody remembered to set.
      </p>

      {note && (
        <div role={note.ok ? "status" : "alert"} className="pb-4 text-[12px]"
          style={{ color: note.ok ? "var(--success-ink)" : "var(--error-ink)" }}>
          {note.text}
        </div>
      )}

      {GROUPS.map((g) => {
        const rows = list.filter((r) => r.group === g.id && offered(r));
        const common = { skills, projects, onChange: setEditing, onSave: save, onCancel: () => setEditing(null) };
        return (
          <SettingsCard key={g.id} title={g.label} desc={g.what}
            actions={<Button disabled={!!editing} onClick={() => setEditing(blank(g.id))}>
              <IconLabel icon={<PlusIcon size={ICON.xs} />}>New prompt</IconLabel>
            </Button>}>
            {rows.map((r) => (
              <Fragment key={r.id}>
                <SettingRow
                  label={r.title}
                  hint={<>
                    {r.skill && <span className="block t-mono break-all" style={{ color: "var(--text3)" }}>Skill {r.skill}</span>}
                    {g.id === "conflicts"
                      ? `${r.repo ? `Only in ${projects.find((p) => p.root === r.repo)?.name ?? r.repo.split("/").pop()}` : "Every project"} · ${r.model && r.model !== "auto" ? r.model : "model from the conflict"}`
                      : WHEN.find((w) => w.id === r.when)?.label}
                    {!r.builtIn && " · yours"}
                  </>}
                  status={g.id === "conflicts" ? undefined : <LaunchModeBadge mode={r.permissionMode} />}
                  actions={<Button onClick={() => setEditing(r)}>Edit</Button>} />
                {/* Under the row it belongs to, not at the foot of the page.
                    The editor used to render after the whole list, so pressing
                    Edit on the first prompt appeared to do nothing at all until
                    you scrolled past thirteen others to find it. */}
                {editing?.id === r.id && (
                  <Editor r={editing} presets={[]} {...common}
                    onReset={r.builtIn ? () => void reset(r) : undefined}
                    onDrop={() => void drop(r)} />
                )}
              </Fragment>
            ))}
            {!rows.length && <EmptyState>Nothing here — the built-ins were hidden.</EmptyState>}
            {editing && !editing.id && editing.group === g.id && (
              <Editor r={editing} presets={list.filter((x) => x.builtIn && (x.group === "conflicts") === (g.id === "conflicts"))} {...common} />
            )}
          </SettingsCard>
        );
      })}

      {/* Not a prompt, and here because this is the page about handing a pull request to a
          reviewer: what else the reviewer may be given. Off for every repository until added. */}
      <SettingsCard title="Review sessions"
        desc="A review plugin that asks for it can read a short summary of the agent session that wrote a pull request.">
        <SettingRow
          settingId="plugins.sessionReads.repos"
          label="Let review plugins read the authoring session"
          hint="Shared, for the repositories below only: the first request, the files the agent wrote, how many tools it used, and its closing summary — cut short, with home paths hidden. Never the transcript or any tool output. If anything in it looks like a secret, nothing is shared and the plugin is told why."
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
 * The editor: a form row under the prompt it changes. Stacked labelled
 * fields, one primary Save, and what undoes the prompt (Reset, Hide or
 * Delete) at the far end of the same line, apart from Save and Cancel.
 */
function Editor({ r, skills, projects, presets, onChange, onSave, onCancel, onReset, onDrop }: {
  r: ReviewRecipe; skills: SkillInfo[]; projects: { root: string; name: string }[]; presets: ReviewRecipe[];
  onChange: (r: ReviewRecipe) => void; onSave: (r: ReviewRecipe) => void; onCancel: () => void;
  onReset?: () => void; onDrop?: () => void;
}) {
  const set = (patch: Partial<ReviewRecipe>) => onChange({ ...r, ...patch });
  const uid = useId();
  const f = (k: string) => `${uid}-${k}`;
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

  /* Skills whose name suggests they belong on a pull request go first: this
     list is 60 entries on a real machine and the four that matter here are
     never the four at the top alphabetically. */
  const ordered = useMemo(() => {
    const score = (s: SkillInfo) => (/\b(pr|review|pull)\b|pr-|review/i.test(`${s.name} ${s.category}`) ? 0 : 1);
    return [...skills].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
  }, [skills]);
  const chosen = ordered.find((s) => r.skill?.slice(1).split(/\s/)[0] === s.name);
  const SEL = `w-full ${INPUT}`;

  return (
    <div ref={box} className="agx-settings-row">
      <div className="agx-row-below">
        <SettingsForm label={r.id ? `Edit ${r.title}` : "New prompt"} onSubmit={() => onSave(r)}>
          <Field label="Title" htmlFor={f("title")} help="What the menu shows.">
            <input id={f("title")} ref={first} value={r.title} onChange={(e) => set({ title: e.target.value })}
              aria-describedby={helpIdFor(f("title"))} placeholder="What changed since my review"
              className={INPUT} style={INPUT_STYLE} />
          </Field>
          <Field label="Group" htmlFor={f("group")}>
            <select id={f("group")} value={r.group} onChange={(e) => set({ group: e.target.value as ReviewRecipeGroup })}
              className={SEL} style={INPUT_STYLE}>
              {GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
            </select>
          </Field>

          {r.group === "conflicts" ? (
            <>
              <Field label="Project" htmlFor={f("repo")} help={r.builtIn ? "Choosing one saves a copy for it." : undefined}>
                <select id={f("repo")} value={r.repo ?? ""} onChange={(e) => set({ repo: e.target.value || undefined })}
                  aria-describedby={r.builtIn ? helpIdFor(f("repo")) : undefined} className={SEL} style={INPUT_STYLE}>
                  <option value="">Every project</option>
                  {projects.map((p) => <option key={p.root} value={p.root}>{p.name}</option>)}
                  {/* A project that is no longer listed (moved, hidden, the list did
                      not load) must not read as "every project" while the old path
                      is still what gets saved. */}
                  {r.repo && !projects.some((p) => p.root === r.repo) && <option value={r.repo}>{r.repo.split("/").pop()} (not found)</option>}
                </select>
              </Field>
              <Field label="Model" htmlFor={f("model")}>
                <select id={f("model")} value={r.model ?? "auto"} onChange={(e) => set({ model: e.target.value as ConflictModel })}
                  className={SEL} style={INPUT_STYLE}>
                  {MODELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </Field>
              <Field label="Effort" htmlFor={f("effort")}>
                <select id={f("effort")} value={r.effort ?? "auto"} onChange={(e) => set({ effort: e.target.value as ConflictEffort })}
                  className={SEL} style={INPUT_STYLE}>
                  {EFFORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </Field>
            </>
          ) : (
            <Field label="Suggest it" htmlFor={f("when")}>
              <select id={f("when")} value={r.when} onChange={(e) => set({ when: e.target.value as ReviewRecipeWhen })}
                className={SEL} style={INPUT_STYLE}>
                {WHEN.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
              </select>
            </Field>
          )}

          {/* Not on a conflict prompt: that tab is opened by the merge view with
              its own model choice, and the field would be one that does nothing. */}
          {r.group !== "conflicts" && (
            <Field label="Permission mode" htmlFor={f("mode")} help="How the terminal this prompt opens asks before a tool runs.">
              <LaunchModeSelect id={f("mode")} value={r.permissionMode} className={SEL} style={INPUT_STYLE}
                onChange={(m) => set({ permissionMode: m })} />
            </Field>
          )}

          {/* The skill, in two halves: which one, and what to pass it. Split
              because the arguments are where the placeholders go and a single
              text box made people type the slash and the name by hand every
              time — with the name being the half the machine already knows. */}
          <Field label="Run a skill" htmlFor={f("skill")} help="Optional.">
            <select id={f("skill")} value={chosen?.name ?? ""} className={SEL} style={INPUT_STYLE}
              aria-describedby={helpIdFor(f("skill"))}
              onChange={(e) => {
                const name = e.target.value;
                if (!name) { set({ skill: "" }); return; }
                const rest = r.skill?.split(/\s+/).slice(1).join(" ") ?? "";
                set({ skill: `/${name}${rest ? ` ${rest}` : ""}` });
              }}>
              <option value="">— none, just the prompt —</option>
              {ordered.map((s) => <option key={s.path} value={s.name}>/{s.name}</option>)}
            </select>
          </Field>
          <Field label="Arguments" htmlFor={f("args")} help={chosen?.argument_hint}>
            <input id={f("args")} value={r.skill?.split(/\s+/).slice(1).join(" ") ?? ""}
              disabled={!chosen}
              aria-describedby={chosen?.argument_hint ? helpIdFor(f("args")) : undefined}
              placeholder={chosen?.argument_hint ?? "{number}"}
              onChange={(e) => set({ skill: `/${chosen?.name ?? ""}${e.target.value ? ` ${e.target.value}` : ""}` })}
              className={`t-mono ${INPUT}`} style={{ ...INPUT_STYLE, opacity: chosen ? 1 : 0.5 }} />
          </Field>

          <Field label="The prompt" htmlFor={f("body")} help={r.skill ? "Sent after the skill line, as context." : undefined}>
            <textarea id={f("body")} value={r.body} onChange={(e) => set({ body: e.target.value })}
              aria-describedby={r.skill ? helpIdFor(f("body")) : undefined}
              rows={Math.min(40, Math.max(20, r.body.split("\n").length + 1))} spellCheck={false}
              placeholder={"Pull request #{number} of {repo}.\n\nRead-only: change nothing…"}
              className="w-full text-[12px] px-2.5 py-2 rounded-lg outline-none t-mono bg-[var(--surface-inset)] text-[var(--text)]"
              style={{ ...INPUT_STYLE, resize: "vertical" }} />
          </Field>

          <div className="flex flex-wrap gap-1" role="group" aria-label="Placeholders">
            {(r.group === "conflicts" ? CONFLICT_TOKENS : TOKENS).map(([tok, what]) => (
              <Button key={tok} size="compact" title={what} className="t-mono"
                onClick={() => set({ body: `${r.body}${tok}` })}>{tok}</Button>
            ))}
          </div>

          {/* Starting from one that exists beats starting from an empty box: the
              built-ins are the worked examples, and copying one is how somebody
              gets a prompt of their own that is any good. */}
          {!r.id && !!presets.length && (
            <Field label="Or start from one of these" htmlFor={f("preset")}>
              <select id={f("preset")} value="" className={SEL} style={INPUT_STYLE}
                onChange={(e) => {
                  const p = presets.find((x) => x.id === e.target.value);
                  if (p) set({ title: `${p.title} (mine)`, body: p.body, skill: p.skill, group: p.group, when: p.when, model: p.model, effort: p.effort });
                }}>
                <option value="">— empty —</option>
                {presets.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </Field>
          )}

          <div className="agx-sform-actions">
            <Button type="submit" tone="primary">Save</Button>
            <Button onClick={onCancel}>Cancel</Button>
            {(onReset || onDrop) && <span className="flex-1" />}
            {onReset && <Button onClick={onReset} title="Back to the wording it ships with">Reset</Button>}
            {onDrop && (
              <Button tone="danger" onClick={onDrop} title={r.builtIn ? "Take it out of the menu" : "Delete it"}>
                {r.builtIn ? "Hide" : "Delete"}
              </Button>
            )}
          </div>
        </SettingsForm>
      </div>
    </div>
  );
}
