/*
 * Teaching it about you — the screen somebody meets on the day they install.
 *
 * The whole feature rests on a claim: most of what it would take to predict a
 * person is already on their machine. This is where that claim is made
 * concrete, source by source, with the counts in front of them.
 *
 * THREE RULES SHAPE THIS SCREEN.
 *
 * Consent is per source and defaults to no. These paths are not alike — one is
 * a page of conventions somebody wrote on purpose, another is two gigabytes of
 * everything they have said to a machine for a year, most of it about
 * private work. One checkbox over both would be the worst mistake
 * this feature could make.
 *
 * Nothing is read until a button is pressed. Listing shows names, counts and
 * sizes and opens no file, so a person can look at the whole inventory, change
 * their mind twice, and never have had anything read.
 *
 * The exclusion list comes FIRST, above the sources, because it is the only
 * control here that can prevent something rather than undo it.
 */
import { useCallback, useEffect, useState, useRef } from "react";
import type { UnderstudyLearned, UnderstudySource } from "../../../../shared/types.ts";
import { SERVER, authHeaders } from "../../lib/api.ts";
import { Button } from "../workspace/Chrome.tsx";
import { Empty } from "../git/ui.tsx";
import { SettingRow } from "../SettingRow.tsx";
import { Field, SettingsCard, SettingsForm, StatusBadge } from "../SettingsKit.tsx";
import { fmtBytes } from "../../lib/goneCleanup.ts";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { ClockIcon, ListIcon, PlayIcon } from "../../lib/glyphIcons.tsx";
import { ChecklistIcon, FolderIcon, ShieldIcon } from "../settingsNavIcons.tsx";
import { UnderstudyIcon } from "../workspace/icons.tsx";
import { INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";

interface SourcesBody {
  sources: UnderstudySource[];
  never: string[];
  terms: { ok: boolean; count: number; path: string };
  policy: { rules: number; classes: number; at: number } | null;
  learned: UnderstudyLearned | null;
  banked: number;
  /** Everything ever refused for a private term, not just the last read. */
  refusedEver?: number;
  byClass: Record<string, number>;
}

/** A moment, short enough to sit on one line beside a button. */
const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const post = async (path: string, body: unknown) => {
  const r = await fetch(SERVER + path, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return { ok: r.ok, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
};

/* The app already formats bytes; a second copy here is one more place for
   "1.0 MB" and "1 MB" to disagree — and it tripped the no-thresholds guard,
   which reads every number-against-number in this directory as a policy
   threshold and is right to be that blunt. */

/**
 * The control that decides what is read off this machine.
 *
 * It was 20x20 with a 14px glyph — the smallest target in the view, failing
 * WCAG 2.2's 24x24 floor on both axes, on the one control whose consequence is
 * "what may this thing read about me". Measured in the running app: 32 of the
 * 83 targets on the Teach tab were this box.
 *
 * `HIT` (26) and `ICON.md` (16), and it draws when the pointer is over its row
 * as well as when it is over the box, because the row is the target now.
 *
 * `role="checkbox"` and not `switch`: it is drawn as a square with a tick, and
 * a role that disagrees with the shape is read out as the wrong control.
 */
function TickBox({ on, onClick, disabled, title, plain }: {
  on: boolean; onClick?: () => void; disabled?: boolean; title: string;
  /** Only the picture: the row around it is the control. A button inside a
   *  button row is invalid, so a row that is itself operable draws this. */
  plain?: boolean;
}) {
  const box = (
    <svg width={ICON.md} height={ICON.md} viewBox="0 0 24 24" fill="none"
      stroke={on ? "var(--primary)" : "var(--text3)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      {on && <path d="M7 12.5l3.2 3.2L17 9" />}
    </svg>
  );
  const style = { width: HIT, height: HIT, opacity: disabled ? 0.4 : 1 };
  if (plain) {
    return <span aria-hidden className="agx-tick shrink-0 grid place-items-center rounded-md" style={style}>{box}</span>;
  }
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={title}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="agx-tick shrink-0 grid place-items-center rounded-md"
      style={style}
    >
      {box}
    </button>
  );
}

/** Precedents are one row per project and a machine can hold hundreds: the page was 9000px tall at 1440. */
const PRECEDENT_ROWS = 8;

export function Teach({ active }: { active: boolean }) {
  const [data, setData] = useState<SourcesBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [neverText, setNeverText] = useState("");
  const [addPath, setAddPath] = useState("");
  const [allPrecedents, setAllPrecedents] = useState(false);
  /* Above the early returns below, and that is the whole point: this sat under
     `if (!data) return` for one build and took the panel down the moment the
     data arrived, because the hook count changed between the loading render
     and the loaded one. React answers that with an invariant error and a blank
     document, which looks exactly like a broken build. */
  const receipt = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(SERVER + "/understudy/sources", { headers: authHeaders() });
      if (!r.ok) return;
      const b = (await r.json()) as SourcesBody;
      if (b && Array.isArray(b.sources)) {
        setData(b);
        setNeverText(b.never.join("\n"));
      }
    } catch { /* the panel says nothing rather than guessing */ }
  }, []);

  useEffect(() => { if (active) void load(); }, [active, load]);

  if (!active) return null;
  if (!data) return <Empty what="what is on this machine" busy />;

  const rules = data.sources.filter((s) => s.kind === "rules");
  const precedents = data.sources.filter((s) => s.kind === "precedents");
  const shownPrecedents = allPrecedents ? precedents : precedents.slice(0, PRECEDENT_ROWS);
  const allowedCount = data.sources.filter((s) => s.allowed && s.found).length;

  const toggle = async (s: UnderstudySource) => {
    setProblem(null);
    const r = await post("/understudy/allow", { id: s.id, allowed: !s.allowed });
    if (r.ok) void load();
  };

  const saveNever = async () => {
    const list = neverText.split("\n").map((x) => x.trim()).filter(Boolean);
    await post("/understudy/never", { never: list });
    void load();
  };

  const add = async () => {
    if (!addPath.trim()) return;
    const r = await post("/understudy/source/add", { path: addPath.trim() });
    if (!r.ok) setProblem("That path is not one we can read.");
    else { setAddPath(""); void load(); }
  };

  const applyRecommended = async (everything = false) => {
    setBusy(true);
    await post("/understudy/recommend", { everything });
    setBusy(false);
    void load();
  };

  /*
   * "Has it read anything?" must survive a restart, and `learned` does not — it
   * is the report of one run, held in memory. What persists is the compiled
   * policy and the bank, so those are what the question is asked of.
   *
   * Getting this wrong reproduces the original complaint exactly: reopen the
   * app after a successful run and the button offers to do it all over again as
   * if nothing had happened.
   */
  const read = !!data.learned || !!data.policy;

  const learn = async (iAcceptNoTermsList = false) => {
    setBusy(true);
    setProblem(null);
    const r = await post("/understudy/learn", iAcceptNoTermsList ? { iAcceptNoTermsList: true } : {});
    setBusy(false);
    if (!r.ok) setProblem(String(r.body?.error ?? "It refused to read anything."));
    await load();
    // Reported as "it goes like that for a few seconds and then back again —
    // did it actually do anything?". It had: 1,645 files, 1,203 rules, 4,063
    // precedents. But the button returned to the same words it started with
    // and the receipt sits below the fold under twenty-nine source rows, so
    // from where the person was sitting nothing happened at all. Bring the
    // receipt to them rather than leaving it to be found.
    requestAnimationFrame(() => receipt.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

  /* The largest source on the list, so a bar is a comparison and not a raw
     byte count nobody can hold in their head. Floors at 1 so a list of empty
     sources cannot divide by zero. */
  const biggest = Math.max(1, ...(data?.sources ?? []).map((x) => x.bytes || 0));

  /*
   * One row per source, and the whole row is the target for the ones the
   * person did not add: 20x20 was the smallest thing on the screen and the
   * most consequential — this is what says whether the understudy may read
   * your conventions, your skills, your memory — and as a row it is a target
   * you cannot miss rather than one you aim at. A source the person added
   * also carries a Remove, and a button cannot sit inside a button row, so
   * that row is plain and its tick is the real checkbox.
   *
   * A SCHEDULE, NOT THIRTY-SIX PARAGRAPHS: the bar says what a tick never
   * could — which source is actually shaping the answers — scaled against the
   * largest on the list; where it is filed is the badge.
   */
  const Source = ({ s }: { s: UnderstudySource }) => {
    const badges = (
      <>
        {s.found && (s.sensitive
          /* WHERE IT IS FILED, not whose work it is. The first version of this
             said "somebody else's work", which told the reader the opposite of
             the truth — it is all their work. What the flag decides is the
             partition, and the partition decides where a name may end up,
             never whether the material may be read. */
          ? <span title="Filed closed. Read and learned from like everything else — but retrieval can never surface it into anything bound for a public repository."><StatusBadge tone="off">Kept private</StatusBadge></span>
          : <span title="Your open project. Rows from here may be used for predictions about public work."><StatusBadge tone="off">Open project</StatusBadge></span>)}
        {s.recommended && <StatusBadge tone="ok">Suggested</StatusBadge>}
        {!s.found && <StatusBadge tone="off">Not found</StatusBadge>}
      </>
    );
    const hint = s.found ? (
      <>
        <span className="block tabular-nums">{s.files.toLocaleString()} files · {fmtBytes(s.bytes)}</span>
        {s.bytes > 0 && (
          <span aria-hidden className="block mt-1.5"
            style={{
              height: 3, borderRadius: 2,
              width: `${Math.max(2, Math.round((s.bytes / biggest) * 100))}%`,
              maxWidth: "18rem",
              background: s.sensitive ? "var(--phone)" : "var(--primary)",
              opacity: s.added ? 1 : .35,
            }} />
        )}
      </>
    ) : undefined;
    const title = s.found ? `Let it read ${s.label}` : `${s.label} — not on this machine`;
    /* The sentence and the path are the row's own hover: thirty-six
       paragraphs were the densest block in the panel, and the name says which
       row this is. */
    const label = <span title={`${s.what}\n${s.path}`}>{s.label}</span>;
    if (s.added) {
      return (
        <SettingRow label={label} hint={hint} disabled={!s.found}
          status={badges}
          control={<TickBox on={s.allowed} disabled={!s.found} onClick={() => void toggle(s)} title={title} />}
          actions={
            <Button tone="danger" label={`Remove ${s.label}`}
              title="Stop reading this, and forget it is on the list."
              onClick={() => void post("/understudy/source/remove", { id: s.id }).then(load)}>
              Remove
            </Button>
          } />
      );
    }
    return (
      <SettingRow label={label} hint={hint} disabled={!s.found}
        role="checkbox" ariaChecked={s.allowed}
        onClick={s.found ? () => void toggle(s) : undefined}
        status={badges}
        control={<TickBox plain on={s.allowed} disabled={!s.found} title={title} />} />
    );
  };

  const stepTone = (done: boolean, active: boolean) => done ? "ok" as const : active ? "warn" as const : "off" as const;
  const stepWord = (done: boolean, active: boolean, doneText: string) => done ? doneText : active ? "Your turn" : "Later";
  const step1Active = data.never.length === 0;
  const step2Active = data.never.length > 0 && allowedCount === 0;
  const step3Active = allowedCount > 0 && !data.learned;

  return (
    <>
      {/* The gate that decides whether reading is safe at all. First, because
          it is the only thing here that can prevent rather than undo. */}
      {!data.terms.ok && (
        <SettingsCard title="Private-terms list" status={<StatusBadge tone="err">Missing</StatusBadge>}>
          <SettingRow label="It will not read anything yet"
            hint={<>
              There is no private-terms list at <span className="t-mono break-all">{data.terms.path}</span>. That list is what stops a private name reaching a
              file it should not, and without it this cannot tell "checked, clean" from "could not check" — so it refuses
              rather than guessing. Create the file (one name, word or pattern per line; <span className="t-mono">AGENTGLASS_PRIVATE_TERMS</span> points
              it elsewhere), or say so here if this machine genuinely has nothing to protect.
            </>}
            actions={
              <Button tone="danger" disabled={busy || allowedCount === 0}
                onClick={() => void learn(true)}
                title="Reads the ticked sources with no private-terms check at all. Only for a machine with nothing on it that must not leave.">
                Read anyway — nothing here is private
              </Button>
            } />
        </SettingsCard>
      )}

      {/* The way in, for somebody who has just opened this and has no idea
          which of twenty rows to tick. One press does the whole of steps one
          and two with a defensible answer, and every part of it can be undone
          by hand afterwards. One sentence, and the proof a click away: the
          reasoning is all correct and all of it answers questions nobody has
          asked yet. */}
      <SettingsCard title="What the orchestrator learns from" icon={<UnderstudyIcon size={ICON.sm} />}
        desc="Three steps: what it must never see, what it may read, and then reading it.">
        <SettingRow label="Set this up for me"
          hint="It reads the repositories on this machine and learns how you decide. Nothing leaves it."
          actions={<>
            <Button tone="primary" onClick={() => void applyRecommended(false)} disabled={busy}>Set this up for me</Button>
            <Button onClick={() => void applyRecommended(true)} disabled={busy}
              title="Adds the scratch directories too — the litter of one afternoon rather than a record of how you work.">
              Everything I have
            </Button>
          </>}
          detail={{
            summary: "What exactly it reads",
            body: <>
              <b style={{ fontWeight: 400, color: "var(--text)" }}>Set this up for me</b> ticks everything real on this machine — your work
              included, because that is where most of your decisions are. It skips only scratch directories.{" "}
              <b style={{ fontWeight: 400, color: "var(--text)" }}>Everything I have</b> adds those too.{" "}
              <b style={{ fontWeight: 400, color: "var(--text)" }}>Reading is not the risk.</b> Anything outside your open project is filed
              <em> kept private</em>, and retrieval can never cross that line — a prediction about public work cannot
              surface a private row. The one thing it cannot do is recognise a name nobody told it about, which is
              what step 1 is for.
            </>,
          }} />
      </SettingsCard>

      <SettingsCard title="What it must never see" icon={<ShieldIcon size={ICON.sm} />}
        status={<StatusBadge tone={stepTone(!step1Active, step1Active)}>
          {stepWord(!step1Active, step1Active, `${data.never.length} word${data.never.length === 1 ? "" : "s"}`)}
        </StatusBadge>}
        desc="Step 1. The only control here that can prevent something rather than undo it.">
        <SettingRow label="Words it must never read"
          hint="One per line. Anything with these words in its path or its text is not read — not skimmed, not stored, not summarised. Plain words rather than patterns, on purpose: you should be able to predict this exactly."
          below={
            <div className="flex flex-col gap-1.5" style={{ maxWidth: 480 }}>
              <textarea
                value={neverText}
                onChange={(e) => setNeverText(e.target.value)}
                onBlur={() => void saveNever()}
                aria-label="Words it must never read"
                aria-describedby="never-help"
                spellCheck={false}
                rows={4}
                placeholder={"Documents/private\nclient-name\n.ssh"}
                className="w-full px-2.5 py-2 text-[12px] rounded-lg bg-[var(--surface-inset)] text-[var(--text)] outline-none"
                style={{ ...INPUT_STYLE, fontFamily: "inherit", resize: "vertical" }}
              />
              <div id="never-help" className="agx-field-h">{data.never.length} in the list · saved when you click away</div>
            </div>
          } />
      </SettingsCard>

      <SettingsCard title="Rules you wrote down" icon={<ChecklistIcon size={ICON.sm} />}
        status={<StatusBadge tone={stepTone(allowedCount > 0, step2Active)}>
          {stepWord(allowedCount > 0, step2Active, `${allowedCount} ticked`)}
        </StatusBadge>}
        desc="Step 2. Rules — you saying what you do. Deliberate, written for an audience, and the highest-quality material here. These become the policy it reads before every prediction.">
        {rules.map((s) => <Source key={s.id} s={s} />)}
      </SettingsCard>

      <SettingsCard title="What you actually did" icon={<ClockIcon size={ICON.sm} />}
        desc="Precedents — the record, not the intent. Messier and far larger. A rule says “never main”; a precedent says what you actually did on a Tuesday when the base had moved. Only precedents can make a prediction yours rather than merely sensible. One row per project rather than one switch, because each project is filed separately — and which side of that line a project sits on decides where its rows may ever be used, not whether they may be read.">
        {shownPrecedents.map((s) => <Source key={s.id} s={s} />)}
        {precedents.length > PRECEDENT_ROWS && (
          <div className="agx-settings-x py-2">
            <Button size="compact" onClick={() => setAllPrecedents((v) => !v)}>
              {allPrecedents ? "Show fewer" : `Show all ${precedents.length}`}
            </Button>
          </div>
        )}
      </SettingsCard>

      <SettingsCard title="Somewhere else" icon={<FolderIcon size={ICON.sm} />}>
        <SettingRow label="Add a folder"
          hint="A folder of notes, a journal, anything else you keep. Markdown is read as rules; everything else as record."
          below={
            <SettingsForm label="Add a folder" onSubmit={() => void add()}>
              <Field label="Folder path" htmlFor="understudy-add-path">
                <input id="understudy-add-path"
                  value={addPath}
                  onChange={(e) => setAddPath(e.target.value)}
                  spellCheck={false}
                  placeholder="/home/you/notes"
                  className={`w-full ${INPUT}`}
                  style={INPUT_STYLE} />
              </Field>
              <div className="agx-sform-actions"><Button type="submit">Add</Button></div>
            </SettingsForm>
          } />
        {problem && <div role="alert" className="agx-settings-x pt-2 pb-3 text-[12px]" style={{ color: "var(--error-ink)" }}>{problem}</div>}
      </SettingsCard>

      <SettingsCard title="Let it read them" icon={<PlayIcon size={ICON.sm} />}
        status={<StatusBadge tone={stepTone(!!data.learned, step3Active)}>
          {stepWord(!!data.learned, step3Active, "Done")}
        </StatusBadge>}
        desc="Step 3. Local only: no network, no model, no key.">
        {/* The outcome, next to the thing that caused it. This used to say the
            same sentence before and after, so a run that read sixteen hundred
            files looked identical to no run at all. */}
        <SettingRow label="Read what is ticked"
          hint={allowedCount === 0
            ? "Nothing is allowed yet, so there is nothing to read."
            : read
              ? <>{data.learned
                    ? `Read ${data.learned.filesRead.toLocaleString()} files at ${when(data.learned.at)}`
                    : `Last read ${when(data.policy!.at)}`} —{" "}
                  <b style={{ fontWeight: 400, color: "var(--text)" }}>{(data.policy?.rules ?? 0).toLocaleString()} rules</b>,{" "}
                  <b style={{ fontWeight: 400, color: "var(--text)" }}>{data.banked.toLocaleString()} precedents</b>
                  {data.learned && data.learned.quarantined > 0 && <>, {data.learned.quarantined} refused</>}. Detail below.</>
              : "Reads only what is ticked."}
          actions={
            <Button tone="primary" onClick={() => void learn()} disabled={busy || allowedCount === 0}>
              {busy
                ? "Reading…"
                : read
                  ? "Read them again"
                  : `Learn from ${allowedCount} source${allowedCount === 1 ? "" : "s"}`}
            </Button>
          } />
      </SettingsCard>

      {(data.learned || data.policy) && (
        <SettingsCard title="What it knows now" icon={<ListIcon size={ICON.sm} />}
          desc="The rules are compiled into files you can open and argue with. What it believes about you should never be something you have to query a database to find out.">
          <SettingRow rowRef={receipt} label="Rules" control={<span className="tabular-nums text-[15px]">{data.policy?.rules ?? 0}</span>} />
          <SettingRow label="Precedents" control={<span className="tabular-nums text-[15px]">{data.banked.toLocaleString()}</span>} />
          {/*
            * EVER, not "in the last read", and the difference showed a zero
            * on a machine with eight refusals on record.
            *
            * `learned.quarantined` is counted in memory during one pass and
            * discarded with it, so this read 0 whenever the last read
            * happened to refuse nothing — while the table that records
            * them held eight. Wrong in the dangerous direction: a zero
            * here reads as "the privacy gate has never had to stop
            * anything", and that is the one thing this figure exists to
            * report honestly.
            *
            * The last read's own number stays in the sentence below, where
            * it says which pass it is talking about.
            */}
          <SettingRow label="Refused"
            hint={data.refusedEver
              ? `${data.refusedEver} passages have been refused for holding a private term, across every read. The term itself is never stored — only that one matched.`
              : "Nothing has ever tripped the private-terms list."}
            control={<span className="tabular-nums text-[15px]" style={{ color: data.refusedEver ? "var(--warning-ink)" : "var(--text3)" }}>{(data.refusedEver ?? 0).toLocaleString()}</span>} />
          {data.learned && (
            /* "new", not "precedents", and the difference caused a real
               false alarm: a second run over the same transcripts reports
               near-zero here while the bank is fully populated, because a
               precedent already banked is recognised and not duplicated. The
               column was reading as "this source gave almost nothing". */
            <SettingRow label="What each source added this time"
              hint={<>
                Read {data.learned.filesRead.toLocaleString()} files. Counts are what each source added{" "}
                <em>this time</em> — a passage already banked is recognised, not stored twice, so a second
                run over unchanged files reports little and is not doing less.{" "}
                {data.learned.quarantined > 0
                  ? `${data.learned.quarantined} passages were refused because a private term was in them — they were dropped, not stored.`
                  : "Nothing tripped the private-terms list."}
              </>}
              below={
                <div>
                  {data.learned.bySource.map((b) => (
                    <div key={b.id} className="flex items-baseline gap-2 text-[12px] py-0.5">
                      <span className="flex-1 min-w-0 break-words" style={{ color: "var(--text3)" }}>{b.label}</span>
                      <span className="tabular-nums" style={{ color: "var(--text3)" }}>{b.rules} rules</span>
                      <span className="tabular-nums" style={{ color: "var(--text3)" }}>{b.precedents} new</span>
                    </div>
                  ))}
                </div>
              } />
          )}
        </SettingsCard>
      )}
    </>
  );
}
