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
import { useEffect, useState, useRef } from "react";
import type { UnderstudyLearned, UnderstudySource } from "../../../../shared/types.ts";
import { SERVER, authHeaders } from "../../lib/api.ts";
import { Button } from "../workspace/Chrome.tsx";
import { Empty } from "../git/ui.tsx";
import { FormInput } from "../settings/shell/FormInput.tsx";
import { Section } from "../settings/shell/Section.tsx";
import { SettingRow } from "../settings/shell/SettingRow.tsx";
import { DangerAction } from "../settings/save/index.ts";
import { useReportNeeds } from "../SettingsPageState.tsx";
import { registerRead, useSettingsData } from "../settings/shell/pageLoad.tsx";
import { ProblemNote } from "../SettingsKit.tsx";
import { fmtBytes } from "../../lib/goneCleanup.ts";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { fileCount } from "../../lib/fileCount.ts";

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

/* Through the Settings cache, so the page opens with the last read and the nav can warm it on hover.
   A body that is not a sources list is a failed read, not an empty one. */
const SOURCES = "understudy/sources";
registerRead("understudy", SOURCES, async () => {
  const r = await fetch(SERVER + "/understudy/sources", { headers: authHeaders() });
  if (!r.ok) throw new Error(String(r.status));
  const b = (await r.json()) as SourcesBody;
  if (!b || !Array.isArray(b.sources)) throw new Error("not a sources list");
  return b;
});

export function Teach({ active }: { active: boolean }) {
  /* The read of the sources answered nothing (`loadFailed`). It used to leave "Reading what is on this machine…" up for good. */
  const { data: read0, failed: loadFailed, reload } = useSettingsData<SourcesBody>(SOURCES, active);
  const data = read0 ?? null;
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

  const load = reload;
  // Every fresh read puts the saved list back in the box, as the old local read did.
  useEffect(() => { if (data) setNeverText(data.never.join("\n")); }, [data]);
  /* The one red thing on this page is the nav mark too; a wizard step that is "your turn" is a next step, not a problem. */
  useReportNeeds("understudy", data && !data.terms.ok ? { count: 1, title: "The private-terms list is missing, so nothing is read yet" } : null);

  if (!active) return null;
  if (!data) {
    return loadFailed
      ? <ProblemNote title="Could not read what is on this machine" action={<Button onClick={() => { void load(); }}>Try again</Button>}>
          The local server did not answer, so nothing here is known. Nothing was changed.
        </ProblemNote>
      : <Empty what="what is on this machine" busy />;
  }

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
    const facts = [
      s.found ? `${fileCount(s.files)}, ${fmtBytes(s.bytes)}` : "Not found on this machine",
      s.found ? (s.sensitive ? "Kept private" : "Open project") : "",
      s.recommended ? "Suggested" : "",
    ].filter(Boolean).join(". ") + ".";
    const title = s.found ? `Let it read ${s.label}` : `${s.label} is not on this machine`;
    return (
      <SettingRow kind="control" label={s.label} help={facts}
        control={<>
          <TickBox on={s.allowed} disabled={!s.found} onClick={() => void toggle(s)} title={title} />
          {s.added && (
            <DangerAction label="Remove" onConfirm={() => post("/understudy/source/remove", { id: s.id }).then(load)} />
          )}
        </>} />
    );
  };

  const stepTone = (done: boolean, active: boolean) => done ? "ok" as const : active ? "info" as const : "off" as const;
  const stepWord = (done: boolean, active: boolean, doneText: string) => done ? doneText : active ? "Your turn" : "Later";
  const step1Active = data.never.length === 0;
  const step2Active = data.never.length > 0 && allowedCount === 0;
  const step3Active = allowedCount > 0 && !data.learned;

  return (
    <>
      {/* The gate that decides whether reading is safe at all. First, because it is the only thing here that can prevent rather than undo. */}
      {!data.terms.ok && (
        <Section id="learn-terms" title="Private-terms list" intro="Without this list it refuses to read anything.">
          <SettingRow kind="control" label="It will not read anything yet"
            help="There is no private-terms list, so it cannot tell clean from unchecked."
            control={
              <Button tone="danger" disabled={busy || allowedCount === 0} onClick={() => void learn(true)}
                title="Reads the ticked sources with no private-terms check at all. Only for a machine with nothing on it that must not leave.">
                Read anyway
              </Button>
            } />
          <div className="px-3 pb-2.5 text-[12px]" style={{ color: "var(--text2)" }}>
            Create <span className="t-mono break-all">{data.terms.path}</span> with one name, word or pattern per line, or say so here if this machine has nothing to protect.
          </div>
        </Section>
      )}

      <Section id="learn-setup" title="What the orchestrator learns from" intro="Three steps: what it must never see, what it may read, and then reading it.">
        <SettingRow kind="control" label="Set this up for me"
          help="Reads the repositories on this machine. Nothing leaves it."
          control={<>
            <Button tone="primary" onClick={() => void applyRecommended(false)} disabled={busy}>Set this up for me</Button>
            <Button onClick={() => void applyRecommended(true)} disabled={busy}
              title="Adds the scratch directories too: the litter of one afternoon rather than a record of how you work.">
              Everything I have
            </Button>
          </>} />
        <details className="px-3 pb-2.5 text-[12px]" style={{ color: "var(--text2)" }}>
          <summary className="cursor-pointer">What exactly it reads</summary>
          <p className="mt-1.5">
            <b style={{ fontWeight: 600, color: "var(--text)" }}>Set this up for me</b> ticks everything real on this machine, your work included. It skips only scratch directories.{" "}
            <b style={{ fontWeight: 600, color: "var(--text)" }}>Everything I have</b> adds those too. Anything outside your open project is filed <em>kept private</em>,
            and retrieval can never cross that line. It cannot recognise a name nobody told it about: that is step 1.
          </p>
        </details>
      </Section>

      <Section id="learn-never" title="What it must never see" intro={`Step 1. ${step1Active ? "Your turn." : `${data.never.length} word${data.never.length === 1 ? "" : "s"} listed.`}`}>
        <SettingRow kind="control" label="Words it must never read"
          help="One per line. A path or text with one of these is not read."
          control={
            <div className="flex flex-col gap-1.5" style={{ width: 300, maxWidth: "100%" }}>
              <textarea value={neverText} onChange={(e) => setNeverText(e.target.value)} onBlur={() => void saveNever()}
                aria-label="Words it must never read" spellCheck={false} rows={4} placeholder={"Documents/private\nclient-name\n.ssh"}
                className="w-full px-2.5 py-2 text-[12px] rounded-lg bg-[var(--surface-inset)] text-[var(--text)] outline-none"
                style={{ ...INPUT_STYLE, fontFamily: "inherit", resize: "vertical" }} />
              <div className="text-[11px]" style={{ color: "var(--text2)" }}>{data.never.length} in the list. Saved when you click away.</div>
            </div>
          } />
      </Section>

      <Section id="learn-rules" title="Rules you wrote down" intro={`Step 2. ${allowedCount > 0 ? `${allowedCount} ticked.` : step2Active ? "Your turn." : "Later."} The policy it reads before every prediction.`}>
        {rules.map((s) => <Source key={s.id} s={s} />)}
      </Section>

      <Section id="learn-precedents" title="What you actually did" intro="Precedents are the record, not the intent. One row per project.">
        {shownPrecedents.map((s) => <Source key={s.id} s={s} />)}
        {precedents.length > PRECEDENT_ROWS && (
          <SettingRow kind="control" label={allPrecedents ? "Showing every project" : `Showing ${PRECEDENT_ROWS} of ${precedents.length} projects`}
            control={<Button size="compact" onClick={() => setAllPrecedents((v) => !v)}>{allPrecedents ? "Show fewer" : `Show all ${precedents.length}`}</Button>} />
        )}
      </Section>

      <Section id="learn-folder" title="Somewhere else">
        <SettingRow kind="control" label="Add a folder" help="Notes, a journal, anything else you keep. Markdown is read as rules."
          control={<>
            <FormInput id="understudy-add-path" aria-label="Folder path" value={addPath} onChange={(e) => setAddPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
              spellCheck={false} placeholder="/home/you/notes" className={INPUT} style={{ ...INPUT_STYLE, minWidth: 220 }} />
            <Button onClick={() => void add()}>Add</Button>
          </>} />
        {problem && <div role="alert" className="px-3 py-2 text-[12px]" style={{ color: "var(--error-ink)" }}>{problem}</div>}
      </Section>

      <Section id="learn-read" title="Let it read them" intro={`Step 3. ${data.learned ? "Done." : step3Active ? "Your turn." : "Later."} Local only: no network, no model, no key.`}>
        <SettingRow kind="control" label="Read what is ticked"
          help={allowedCount === 0
            ? "Nothing is allowed yet, so there is nothing to read."
            : read
              ? `${data.learned ? `Read ${fileCount(data.learned.filesRead)} at ${when(data.learned.at)}` : `Last read ${when(data.policy!.at)}`}: ${(data.policy?.rules ?? 0).toLocaleString()} rules, ${data.banked.toLocaleString()} precedents${data.learned && data.learned.quarantined > 0 ? `, ${data.learned.quarantined} refused` : ""}.`
              : "Reads only what is ticked."}
          control={
            <Button tone="primary" onClick={() => void learn()} disabled={busy || allowedCount === 0}>
              {busy ? "Reading…" : read ? "Read them again" : `Learn from ${allowedCount} source${allowedCount === 1 ? "" : "s"}`}
            </Button>
          } />
      </Section>

      {(data.learned || data.policy) && (
        <Section id="learn-knows" title="What it knows now" intro="The rules are compiled into files you can open and argue with.">
          <div ref={receipt} />
          <SettingRow kind="control" agentExempt label="Rules" help="Compiled from the sources you ticked." control={<span className="tabular-nums text-[15px]">{data.policy?.rules ?? 0}</span>} />
          <SettingRow kind="control" agentExempt label="Precedents" help="What you did, banked once." control={<span className="tabular-nums text-[15px]">{data.banked.toLocaleString()}</span>} />
          {/* EVER, not "in the last read": a zero here would read as "the privacy gate never had to stop anything". */}
          <SettingRow kind="control" agentExempt label="Refused"
            help={data.refusedEver ? "Passages refused for a private term, across every read." : "Nothing has ever tripped the private-terms list."}
            control={<span className="tabular-nums text-[15px]" style={{ color: data.refusedEver ? "var(--warning-ink)" : "var(--text3)" }}>{(data.refusedEver ?? 0).toLocaleString()}</span>} />
          {data.learned && (
            <>
              <div className="px-3 pt-2.5 text-[12px] font-medium" style={{ color: "var(--text)" }}>What each source added this time</div>
              <div className="px-3 pb-2.5 text-[12px]" style={{ color: "var(--text2)" }}>
                A passage already banked is recognised, not stored twice, so a second run reports little.
              </div>
              <div className="px-3 pb-2.5">
                {data.learned.bySource.map((b) => (
                  <div key={b.id} className="flex items-baseline gap-2 text-[12px] py-0.5">
                    <span className="flex-1 min-w-0 break-words" style={{ color: "var(--text3)" }}>{b.label}</span>
                    <span className="tabular-nums" style={{ color: "var(--text3)" }}>{b.rules} rules</span>
                    <span className="tabular-nums" style={{ color: "var(--text3)" }}>{b.precedents} new</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>
      )}
    </>
  );
}
