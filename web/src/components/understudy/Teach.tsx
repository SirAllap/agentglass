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
 * everything they have said to a machine for a year, most of it about an
 * employer's private work. One checkbox over both would be the worst mistake
 * this feature could make.
 *
 * Nothing is read until a button is pressed. Listing shows names, counts and
 * sizes and opens no file, so a person can look at the whole inventory, change
 * their mind twice, and never have had anything read.
 *
 * The exclusion list comes FIRST, above the sources, because it is the only
 * control here that can prevent something rather than undo it.
 */
import { useCallback, useEffect, useState, type ReactNode, useRef } from "react";
import type { UnderstudyLearned, UnderstudySource } from "../../../../shared/types.ts";
import { SERVER, authHeaders } from "../../lib/api.ts";
import { Chip } from "../workspace/Chrome.tsx";
import { Empty, wash } from "../git/ui.tsx";
import { fmtBytes } from "../../lib/goneCleanup.ts";
import { HIT, ICON } from "../../lib/iconSize.ts";

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
 * A numbered step, dimmed until its turn.
 *
 * The screen was reported as "very confusing and I do not even know where to
 * start", which is a fair description of what it was: three unrelated jobs
 * stacked down a page with no order implied and no state showing. Numbering
 * them and dimming the ones that are not yet the point is most of the fix —
 * the rest is having a recommended answer so that nobody has to invent one.
 */
function Step({ n, title, hint, done, active, children }: {
  n: number;
  title: string;
  hint?: string;
  done?: boolean;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <section style={{ opacity: active || done ? 1 : 0.55, borderTop: `1px solid ${wash("--border", 40)}` }}>
      <div className="flex items-baseline gap-2 px-4 pt-3">
        <span
          className="grid place-items-center shrink-0 tabular-nums"
          style={{
            width: 18, height: 18, borderRadius: 9, fontSize: 10,
            background: done ? wash("--success", 20) : active ? wash("--primary", 20) : wash("--text", 8),
            color: done ? "var(--success)" : active ? "var(--primary)" : "var(--text4)",
          }}
        >
          {done ? "✓" : n}
        </span>
        <span className="panel-title" style={{ fontSize: 13 }}>{title}</span>
        {hint && <span className="chip t-dim ml-auto">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

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
function TickBox({ on, onClick, disabled, title }: {
  on: boolean; onClick: () => void; disabled?: boolean; title: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={title}
      title={title}
      disabled={disabled}
      onClick={onClick}
      tabIndex={-1}
      className="agx-tick shrink-0 grid place-items-center rounded-md pointer-events-none"
      style={{ width: HIT, height: HIT, opacity: disabled ? 0.4 : 1 }}
    >
      <svg width={ICON.md} height={ICON.md} viewBox="0 0 24 24" fill="none"
        stroke={on ? "var(--primary)" : "var(--text3)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        {on && <path d="M7 12.5l3.2 3.2L17 9" />}
      </svg>
    </button>
  );
}

export function Teach({ active }: { active: boolean }) {
  const [data, setData] = useState<SourcesBody | null>(null);
  /** Whether the "what exactly does it read" detail is open. Closed: it answers
   *  questions a first visit has not asked yet, and it sat between a person and
   *  the button they had just been told to press. */
  const [why, setWhy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [neverText, setNeverText] = useState("");
  const [addPath, setAddPath] = useState("");
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

  /*
   * The whole row is the target, and the box only reports the state.
   *
   * 20x20 was the smallest thing on the screen and the most consequential —
   * this is what says whether the understudy may read your conventions, your
   * skills, your memory. As a row it is roughly 640x48, which is a target you
   * cannot miss rather than one you aim at.
   *
   * The box keeps `role="checkbox"` and the accessible name so nothing is lost
   * to a screen reader, and takes `tabIndex={-1}` plus `pointer-events-none` so
   * there is exactly ONE target here rather than a big one with a small one
   * inside it.
   */
  /* The largest source on the list, so a bar is a comparison and not a raw
     byte count nobody can hold in their head. Floors at 1 so a list of empty
     sources cannot divide by zero. */
  const biggest = Math.max(1, ...(data?.sources ?? []).map((x) => x.bytes || 0));
  const Source = ({ s }: { s: UnderstudySource }) => (
    <div
      role="button"
      tabIndex={s.found ? 0 : -1}
      aria-disabled={!s.found}
      onClick={() => s.found && void toggle(s)}
      onKeyDown={(e) => {
        if (!s.found) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void toggle(s); }
      }}
      className={`flex items-start gap-3 px-4 py-2.5 transition-colors${s.found ? " agx-rowhit" : ""}`}
      style={{ borderTop: `1px solid ${wash("--border", 40)}`, cursor: s.found ? "pointer" : "not-allowed" }}
    >
      <TickBox
        on={s.allowed}
        disabled={!s.found}
        onClick={() => void toggle(s)}
        title={s.found ? `Let it read ${s.label}` : `${s.label} — not on this machine`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span style={{ fontSize: 11.5 }}>{s.label}</span>
          {/* WHERE IT IS FILED, not whose work it is.
              The first version of this chip said "somebody else's work", which
              told the reader the opposite of the truth — it is all their work.
              What the flag decides is the partition, and the partition decides
              where a name may end up, never whether the material may be read. */}
          {s.sensitive
            ? <span className="chip"
                title="Filed closed. Read and learned from like everything else — but retrieval can never surface it into anything bound for a public repository."
                style={{ color: "var(--phone)", background: wash("--phone", 12), borderColor: "transparent" }}>kept private</span>
            : <span className="chip"
                title="Your open project. Rows from here may be used for predictions about public work."
                style={{ color: "var(--success)", background: wash("--success", 10), borderColor: "transparent" }}>open project</span>}
          {s.recommended && <span className="chip" style={{ color: "var(--primary)", background: wash("--primary", 12), borderColor: "transparent" }}>suggested</span>}
          {!s.found && <span className="chip" style={{ color: "var(--text4)" }}>not found</span>}
          {s.found && <span className="chip t-dim tabular-nums">{s.files.toLocaleString()} files · {fmtBytes(s.bytes)}</span>}
          {s.added && (
            /* The only destructive control on the screen, and it was a bare
               `.chip` at 50x19 — pixel-identical to the four decorative spans
               beside it, and under the target floor. */
            <span className="ml-auto" onClick={(e) => e.stopPropagation()}>
              <Chip danger ariaLabel={`Remove ${s.label}`} title="Stop reading this, and forget it is on the list."
                onClick={() => void post("/understudy/source/remove", { id: s.id }).then(load)}>
                <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                </svg>
                remove
              </Chip>
            </span>
          )}
        </div>
        {/*
          * A SCHEDULE, NOT THIRTY-SIX PARAGRAPHS.
          *
          * Every source carried its own sentence and its own path, so the list
          * of what it has read was three lines times thirty-six — the single
          * densest block in the panel, and unreadable as a list.
          *
          * The bar says the thing a tick never could: which source is actually
          * shaping the answers. Scaled against the largest on the list, so it
          * is a comparison rather than a number nobody can hold. The sentence
          * and the path are still here, on the row's own hover.
          */}
        {s.found && s.bytes > 0 && (
          <div className="flex items-center gap-2 mt-1" title={`${s.what}\n${s.path}`}>
            <span aria-hidden
              style={{
                height: 3, borderRadius: 2, flex: "0 0 auto",
                width: `${Math.max(2, Math.round((s.bytes / biggest) * 100))}%`,
                maxWidth: "18rem",
                background: s.sensitive ? "var(--phone)" : "var(--primary)",
                opacity: s.added ? 1 : .35,
              }} />
            <span className="text-[10px] truncate" style={{ color: "var(--text4)", minWidth: 0 }}>{s.what}</span>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="min-h-0 overflow-y-auto">
      {/* The gate that decides whether reading is safe at all. First, because
          it is the only thing here that can prevent rather than undo. */}
      {!data.terms.ok && (
        <div className="px-4 py-2 text-[11.5px] leading-relaxed"
          style={{ color: "var(--text2)", background: wash("--error", 10), borderBottom: `1px solid ${wash("--error", 30)}` }}>
          <b style={{ color: "var(--error)" }}>It will not read anything yet.</b> There is no private-terms list at{" "}
          <span className="tabular-nums">{data.terms.path}</span>. That list is what stops a private name reaching a
          file it should not, and without it this cannot tell "checked, clean" from "could not check" — so it refuses
          rather than guessing. Create the file (one name, word or pattern per line; <span className="tabular-nums">AGENTGLASS_PRIVATE_TERMS</span> points
          it elsewhere), or say so here if this machine genuinely has nothing to protect:
          <div className="mt-1.5">
            <button type="button" className="text-[11px] px-2 py-0.5 rounded-md" disabled={busy || allowedCount === 0}
              style={{ color: "var(--text)", border: `1px solid ${wash("--error", 40)}` }}
              onClick={() => void learn(true)}
              title="Reads the ticked sources with no private-terms check at all. Only for a machine with nothing on it that must not leave.">
              Read anyway — nothing here is private
            </button>
          </div>
        </div>
      )}

      {/* The way in, for somebody who has just opened this and has no idea
          which of twenty rows to tick. One press does the whole of steps one
          and two with a defensible answer, and every part of it can be undone
          by hand afterwards. */}
      <div className="px-4 py-3" style={{ background: wash("--primary", 6) }}>
        <div className="flex items-center gap-3 flex-wrap">
          <Chip on onClick={() => void applyRecommended(false)} disabled={busy}>Set this up for me</Chip>
          <Chip onClick={() => void applyRecommended(true)} disabled={busy}
            title="Adds the scratch directories too — the litter of one afternoon rather than a record of how you work.">
            Everything I have
          </Chip>
          {/*
            * ONE SENTENCE, and the rest a click away.
            *
            * This was six lines of dense text sitting between a person and the
            * button they had just been told to press — the reasoning is all
            * correct and all of it is answering questions nobody has asked yet.
            * The answer to "is this safe" belongs next to the button; the proof
            * belongs under a link for the person who wants it.
            */}
          <span className="text-[11.5px] flex-1 min-w-[240px]" style={{ color: "var(--text2)" }}>
            It reads the repositories on this machine and learns how you decide. Nothing leaves it.
          </span>
          <button className="agx-linkish text-[11px]" style={{ color: "var(--text4)" }}
            onClick={() => setWhy((v) => !v)}>
            {why ? "hide the detail" : "what exactly does it read?"}
          </button>
        </div>
        {why && (
          <div className="text-[11.5px] leading-relaxed mt-2.5" style={{ color: "var(--text2)", maxWidth: "72ch" }}>
            <b style={{ fontWeight: 400 }}>Set this up for me</b> ticks everything real on this machine — your work
            included, because that is where most of your decisions are. It skips only scratch directories.{" "}
            <b style={{ fontWeight: 400 }}>Everything I have</b> adds those too.{" "}
            <b style={{ fontWeight: 400 }}>Reading is not the risk.</b> Anything outside your open project is filed
            <em> kept private</em>, and retrieval can never cross that line — a prediction about public work cannot
            surface a private row. The one thing it cannot do is recognise a name nobody told it about, which is
            what step 1 is for.
          </div>
        )}
      </div>

      <Step n={1} title="Say what it must never see" active={data.never.length === 0} done={data.never.length > 0}
        hint={data.never.length ? `${data.never.length} words` : "empty"}>
      <div className="px-4 pt-2 pb-2">
        <p className="m-0 mt-1 text-[11.5px] leading-relaxed" style={{ color: "var(--text3)" }}>
          One per line. Anything with these words in its path or its text is not read — not skimmed, not stored, not
          summarised. Plain words rather than patterns, on purpose: you should be able to predict this exactly.
        </p>
        <textarea
          value={neverText}
          onChange={(e) => setNeverText(e.target.value)}
          onBlur={() => void saveNever()}
          spellCheck={false}
          rows={4}
          placeholder={"Documents/private\nclient-name\n.ssh"}
          className="w-full mt-2 px-2 py-1.5 text-[11.5px] rounded-lg"
          style={{
            background: wash("--text", 4),
            border: `1px solid ${wash("--border", 60)}`,
            color: "var(--text)",
            fontFamily: "inherit",
            resize: "vertical",
          }}
        />
        <div className="text-[11.5px] mt-1" style={{ color: "var(--text4)" }}>
          {data.never.length} in the list · saved when you click away
        </div>
      </div>
      </Step>

      <Step n={2} title="Choose what it may read" active={data.never.length > 0 && allowedCount === 0}
        done={allowedCount > 0} hint={allowedCount ? `${allowedCount} ticked` : "none yet"}>
      <div className="px-4 pt-2 pb-1">
        <div className="panel-eyebrow">What you wrote down</div>
        <div style={{ fontSize: 11.5, color: "var(--text2)" }}>Rules — you saying what you do</div>
        <p className="m-0 mt-1 text-[11.5px] leading-relaxed" style={{ color: "var(--text3)" }}>
          Deliberate, written for an audience, and the highest-quality material here. These become the policy it reads
          before every prediction.
        </p>
      </div>
      {rules.map((s) => <Source key={s.id} s={s} />)}

      <div className="px-4 pt-3 pb-1" style={{ borderTop: `1px solid ${wash("--border", 40)}` }}>
        <div className="panel-eyebrow">What you actually did</div>
        <div style={{ fontSize: 11.5, color: "var(--text2)" }}>Precedents — the record, not the intent</div>
        <p className="m-0 mt-1 text-[11.5px] leading-relaxed" style={{ color: "var(--text3)" }}>
          Messier and far larger. A rule says "never main"; a precedent says what you actually did on a Tuesday when
          the base had moved. Only precedents can make a prediction yours rather than merely sensible. One row per
          project rather than one switch, because each project is filed separately — and which side of that line a
          project sits on decides where its rows may ever be used, not whether they may be read.
        </p>
      </div>
      {precedents.map((s) => <Source key={s.id} s={s} />)}

      <div className="px-4 py-3" style={{ borderTop: `1px solid ${wash("--border", 40)}` }}>
        <div className="panel-eyebrow">Somewhere else</div>
        <div className="flex gap-2 mt-1">
          <input
            value={addPath}
            onChange={(e) => setAddPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            spellCheck={false}
            placeholder="/home/you/notes"
            className="flex-1 min-w-0 px-2 py-1 text-[11.5px] rounded-lg"
            style={{ background: wash("--text", 4), border: `1px solid ${wash("--border", 60)}`, color: "var(--text)", fontFamily: "inherit" }}
          />
          <Chip onClick={() => void add()}>Add</Chip>
        </div>
        <div className="text-[11.5px] mt-1" style={{ color: "var(--text4)" }}>
          A folder of notes, a journal, anything else you keep. Markdown is read as rules; everything else as record.
        </div>
      </div>

      {problem && (
        <div className="px-4 py-2 text-[11.5px]" style={{ color: "var(--error)", background: wash("--error", 8) }}>
          {problem}
        </div>
      )}

      </Step>

      <Step n={3} title="Let it read them" active={allowedCount > 0 && !data.learned} done={!!data.learned}
        hint={data.learned ? "done" : "local only"}>
      <div className="px-4 py-3 flex items-center gap-3">
        <Chip on onClick={() => void learn()} disabled={busy || allowedCount === 0}>
          {busy
            ? "Reading…"
            : read
              ? "Read them again"
              : `Learn from ${allowedCount} source${allowedCount === 1 ? "" : "s"}`}
        </Chip>
        {/* The outcome, next to the thing that caused it. This used to say the
            same sentence before and after, so a run that read sixteen hundred
            files looked identical to no run at all. */}
        <span className="text-[11.5px]" style={{ color: read ? "var(--text3)" : "var(--text4)" }}>
          {allowedCount === 0
            ? "Nothing is allowed yet, so there is nothing to read."
            : read
              ? <>{data.learned
                    ? `Read ${data.learned.filesRead.toLocaleString()} files at ${when(data.learned.at)}`
                    : `Last read ${when(data.policy!.at)}`} —{" "}
                  <b style={{ fontWeight: 400, color: "var(--text)" }}>{(data.policy?.rules ?? 0).toLocaleString()} rules</b>,{" "}
                  <b style={{ fontWeight: 400, color: "var(--text)" }}>{data.banked.toLocaleString()} precedents</b>
                  {data.learned && data.learned.quarantined > 0 && <>, {data.learned.quarantined} refused</>}. Detail below.</>
              : "Reads only what is ticked. Local — no network, no model, no key."}
        </span>
      </div>

      </Step>

      {(data.learned || data.policy) && (
        <div ref={receipt} className="px-4 py-3" style={{ borderTop: `1px solid ${wash("--border", 40)}`, background: wash("--primary", 5) }}>
          <div className="panel-eyebrow">What it knows now</div>
          <div className="grid gap-3 mt-1.5" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
            <div>
              <div className="text-[10px] uppercase" style={{ letterSpacing: ".08em", color: "var(--text4)" }}>rules</div>
              <div className="tabular-nums" style={{ fontSize: 17 }}>{data.policy?.rules ?? 0}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase" style={{ letterSpacing: ".08em", color: "var(--text4)" }}>precedents</div>
              <div className="tabular-nums" style={{ fontSize: 17 }}>{data.banked.toLocaleString()}</div>
            </div>
            <div>
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
              <div className="text-[10px] uppercase" style={{ letterSpacing: ".08em", color: "var(--text4)" }}>refused</div>
              <div className="tabular-nums" style={{ fontSize: 17, color: data.refusedEver ? "var(--warning)" : "var(--text3)" }}
                title={data.refusedEver
                  ? `${data.refusedEver} passages have been refused for holding a private term, across every read. The term itself is never stored — only that one matched.`
                  : "Nothing has ever tripped the private-terms list."}>
                {(data.refusedEver ?? 0).toLocaleString()}
              </div>
            </div>
          </div>
          {data.learned && (
            <>
              {/* "new", not "precedents", and the difference caused a real
                  false alarm: a second run over the same transcripts reports
                  near-zero here while the bank is fully populated, because a
                  precedent already banked is recognised and not duplicated. The
                  column was reading as "this source gave almost nothing". */}
              <div className="text-[11.5px] mt-2" style={{ color: "var(--text3)" }}>
                Read {data.learned.filesRead.toLocaleString()} files. Counts are what each source added{" "}
                <em>this time</em> — a passage already banked is recognised, not stored twice, so a second
                run over unchanged files reports little and is not doing less.{" "}
                {data.learned.quarantined > 0
                  ? `${data.learned.quarantined} passages were refused because a private term was in them — they were dropped, not stored.`
                  : "Nothing tripped the private-terms list."}
              </div>
              <div className="mt-2">
                {data.learned.bySource.map((b) => (
                  <div key={b.id} className="flex items-baseline gap-2 text-[11.5px] py-0.5">
                    <span className="flex-1 min-w-0 truncate" style={{ color: "var(--text3)" }}>{b.label}</span>
                    <span className="tabular-nums" style={{ color: "var(--text4)" }}>{b.rules} rules</span>
                    <span className="tabular-nums" style={{ color: "var(--text4)" }}>{b.precedents} new</span>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="text-[11.5px] mt-2 leading-relaxed" style={{ color: "var(--text3)" }}>
            The rules are compiled into files you can open and argue with. What it believes about you should never be
            something you have to query a database to find out.
          </div>
        </div>
      )}
    </div>
  );
}
