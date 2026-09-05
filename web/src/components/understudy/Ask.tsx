/*
 * Asking it what you would do.
 *
 * Everything else in this panel is about whether it is any good. This is the
 * tab where what it learned is actually spent — and until it existed, nothing
 * spent it at all: nearly nine thousand precedents and twelve hundred rules
 * read off the machine, compiled, counted two panels away, and queried by
 * nobody. The scorecard was measuring a frequency model over the ledger, which
 * knows the last few decisions taken inside this app and nothing about the
 * person who took them.
 *
 * TWO THINGS IT DELIBERATELY IS NOT.
 *
 * It is not a chat. Nothing here is generated, paraphrased or summarised —
 * every line is something you wrote, with the kind of place it came from beside
 * it. An understudy that produces a plausible opinion and signs your name to it
 * is worse than one that stays quiet, because from the outside you cannot tell
 * which one you are reading.
 *
 * It is not a search box over your files. The partition is chosen before the
 * question is asked and travels with it, because "which of your material may
 * answer this" is not something to infer from a sentence.
 */
import { useCallback, useState } from "react";
import { SERVER, authHeaders } from "../../lib/api.ts";
import { Empty, wash, edge } from "../git/ui.tsx";
import { Chip } from "../workspace/Chrome.tsx";

interface Rule { id: string; cls: string; text: string; src: string; backed: number }
interface Precedent { id: number; cls: string; situation: string; decision: string; hisWords: string; at: number; weight: number; source: string }
interface Verdict {
  answer: string;
  confidence: number;
  why: string;
  declined: boolean;
  error?: string;
}

interface Answer {
  cls: string;
  label: string;
  partition: string;
  rules: Rule[];
  decided: Precedent[];
  said: Precedent[];
  says: string;
  thin: boolean;
}

const when = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/*
 * The two sides, named the way the Teach tab names them.
 *
 * Not a toggle labelled "private": the question is which body of your work may
 * answer this, and a person choosing has to be able to tell what each one is
 * without a legend.
 */
const SIDES = [
  { id: "agentglass", label: "Open project", hint: "Answers from work that could end up in a public repository." },
  { id: "closed", label: "Kept private", hint: "Answers from everything else — your work project, your notes, your machine." },
];

const EXAMPLES = [
  "do I squash when I merge, or keep the commits",
  "what goes in a PR body",
  "when do I delete a worktree",
  "how do I answer a bot review I disagree with",
];

export function Ask({ active }: { active: boolean }) {
  const [q, setQ] = useState("");
  const [side, setSide] = useState(SIDES[0]!.id);
  /** Whether the two settings rows are showing. Closed by default: they are
   *  choices nobody can make before they have seen one answer. */
  const [tuning, setTuning] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [judge, setJudge] = useState<{ enabled: boolean; available: boolean }>({ enabled: false, available: false });
  /* How much material each side holds. Shown on the chips because the default
     side is the smaller one on a real machine — 3,606 rows against 6,857 — so a
     first question lands on the thin half and reads as "it knows nothing about
     me", which is the opposite of true. Not fixed by silently switching the
     default: that decides something about somebody's material without saying
     so. Fixed by showing both numbers. */
  const [banked, setBanked] = useState<Record<string, number>>({});

  const run = useCallback(async (text: string) => {
    const asked = text.trim();
    if (!asked) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await fetch(
        `${SERVER}/understudy/ask?q=${encodeURIComponent(asked)}&partition=${encodeURIComponent(side)}`,
        { headers: authHeaders() },
      );
      const b = (await r.json().catch(() => null)) as {
        ok?: boolean; answer?: Answer; error?: string; banked?: Record<string, number>;
        verdict?: Verdict | null; judge?: { enabled: boolean; available: boolean };
      } | null;
      if (b?.banked) setBanked(b.banked);
      if (b?.judge) setJudge(b.judge);
      setVerdict(b?.verdict ?? null);
      if (!r.ok || !b?.ok || !b.answer) {
        setProblem(String(b?.error ?? "It could not answer that."));
        setAnswer(null);
      } else {
        setAnswer(b.answer);
      }
    } catch {
      setProblem("It could not answer that.");
      setAnswer(null);
    }
    setBusy(false);
  }, [side]);

  const toggleJudge = async (on: boolean) => {
    try {
      const r = await fetch(SERVER + "/understudy/judge", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ on }),
      });
      const b = (await r.json()) as { enabled?: boolean; available?: boolean };
      setJudge({ enabled: b?.enabled === true, available: b?.available !== false });
    } catch { /* the chip simply stays where it was */ }
  };

  if (!active) return null;

  return (
    <div className="min-h-0 overflow-y-auto">
      <div className="px-4 pt-3 pb-2">
        <div className="flex gap-2 items-center">
          <input
            className="agx-input flex-1 min-w-0"
            placeholder="What would you do here?"
            value={q}
            maxLength={400}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void run(q); }}
          />
          <Chip on disabled={busy || !q.trim()} onClick={() => void run(q)}>
            {busy ? "Looking…" : "Ask"}
          </Chip>
        </div>

        {/*
          * A QUESTION TO TRY, before any of the settings.
          *
          * The two rows below decide which corpus answers and whether anything
          * may leave this machine — real choices, and both impossible to make
          * on a first visit, because you have not seen an answer yet. They used
          * to be the first two things on screen with the examples last, which
          * is backwards: the examples are the only control here a stranger can
          * actually use.
          */}
        {!answer && !busy && (
          <div className="mt-2.5">
            <div className="text-[11.5px]" style={{ color: "var(--text3)" }}>
              Ask something you already know the answer to — the point is to read what it says
              against what you would have said.
            </div>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {EXAMPLES.map((e) => (
                <Chip key={e} onClick={() => { setQ(e); void run(e); }}>{e}</Chip>
              ))}
            </div>
          </div>
        )}

        {/* Folded, not buried. What it reads changes the answer more than the
            wording of the question does, and the reading switch decides whether
            a question leaves this machine — so both stay here, and neither is
            in the way. The line says where they stand while closed. */}
        {/* The size is set in `style`, not with a utility class: `.agx-linkish`
            declares `font: inherit`, which resets the shorthand and takes the
            size with it — rendered, this line came out at the container's own
            20px and read as a heading. Seen on the screen, not in the source. */}
        <button className="agx-linkish mt-2.5"
          style={{ color: "var(--text4)", fontSize: 11 }}
          onClick={() => setTuning((v) => !v)}>
          {tuning ? "hide what it reads" : `reading: ${SIDES.find((x) => x.id === side)?.label ?? ""}`}
          {!tuning && judge.available && judge.enabled ? " · may look things up" : ""}
        </button>

        {tuning && <div className="flex flex-wrap gap-1.5 mt-2 items-center">
          {SIDES.map((s) => (
            <Chip key={s.id} on={side === s.id} title={s.hint} onClick={() => setSide(s.id)}>
              {s.label}
              {banked[s.id] ? <span className="tabular-nums" style={{ opacity: 0.65 }}> · {banked[s.id]!.toLocaleString()}</span> : null}
            </Chip>
          ))}
          <span className="text-[10.5px] ml-1" style={{ color: "var(--text4)" }}>
            {SIDES.find((s) => s.id === side)?.hint}
          </span>
        </div>}

        {/* The judge's switch, next to the box rather than buried in Settings:
            it decides whether a question leaves this machine, and that belongs
            where the questions are asked. */}
        {tuning && judge.available && (
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <Chip on={judge.enabled} disabled={busy}
              title="Only used when nothing of yours matches. It is sent your rules and cases for that class — never your files or paths — and it cannot run anything."
              onClick={() => void toggleJudge(!judge.enabled)}>
              {judge.enabled ? "Reading turned on" : "Let it read when I have nothing"}
            </Chip>
            <span className="text-[10.5px]" style={{ color: "var(--text4)" }}>
              {judge.enabled
                ? "When nothing of yours matches, a model reads your rules and cases and says what you would probably do."
                : "Off. Everything above comes off this machine only."}
            </span>
          </div>
        )}


      </div>

      {problem && (
        <div className="px-4 py-2 text-[11.5px]" style={{ color: "var(--error)", background: wash("--error", 8) }}>
          {problem}
        </div>
      )}

      {busy && <Empty what="Looking through what you have written and done…" busy />}

      {/*
        * WHAT THIS TAB IS FOR, in the space where the answer will be.
        *
        * Rendered, this tab was a box, four chips and then a thousand pixels of
        * nothing — measured on the real screen at 1950x1422. A person who has
        * not pressed Ask yet has no idea what pressing it produces, and empty
        * space does not tell them.
        */}
      {!answer && !busy && (
        <div className="px-4 py-8" style={{ maxWidth: "64ch" }}>
          <div className="text-[12.5px]" style={{ color: "var(--text2)" }}>
            What comes back is not an opinion.
          </div>
          <div className="text-[12px] mt-1.5" style={{ color: "var(--text3)" }}>
            It answers with the rules you wrote and the decisions you actually made — quoted, with
            what you said at the time. If nothing of yours covers the question, it says so instead
            of inventing a position for you.
          </div>
          <div className="text-[11.5px] mt-3" style={{ color: "var(--text4)" }}>
            {" "}Reading {`${(banked[side] ?? 0).toLocaleString()}`} of your decisions.
          </div>
        </div>
      )}

      {answer && !busy && (
        <>
          {/*
            * THE FINDING, AND THE MARGIN — the drawing-set shape the work tab
            * already uses. A reading has one answer; everything under it is the
            * material that supports it, and the margin says what it was drawn
            * from and certifies who wrote it.
            *
            * Before this, four headings of equal weight ran down the page —
            * closest match, also in what you wrote, what you recorded, what you
            * said at the time — and the thing you asked for was the first
            * paragraph of the first one.
            */}
          <div className="agx-tb" style={{ gridTemplateColumns: "minmax(0,2.2fr) minmax(0,1fr)" }}>
            <div className="on">
              <div className="agx-tb-k">Finding</div>
              <div className="text-[13px] mt-1" style={{ color: "var(--text2)", lineHeight: 1.5 }}>{answer.says}</div>
            </div>
            <div>
              <div className="agx-tb-k">Drawn from</div>
              <div className="agx-tb-v" style={{ fontSize: 12, fontWeight: 400, color: "var(--text2)" }}>
                {answer.cls} — {answer.label}
              </div>
              {/* The certification. Every line above is quoted from the
                  operator's own material, and when nothing of theirs covers
                  the question the finding says exactly that. */}
              <div className="agx-stamp mt-1.5 inline-block" style={{ color: "var(--success)" }}>
                nothing written by it
              </div>
            </div>
          </div>

          {answer.rules.length > 0 && (
            <div className="px-4 pt-3">
              {/* `ask()` already sorts `rules` by match score before it gets
                  here — the tab just never showed the ranking. Reading "do I
                  squash when I merge" against a real bank put the rule that
                  settles it in position 1 of 6, printed at the same weight as
                  the other 5, so it read as noise and had to be found by
                  reading all six. This is the same list, just no longer flat:
                  the top match is called out, the rest stay a plain list. */}
              <div className="text-[10px] tracking-wide uppercase" style={{ color: "var(--text4)" }}>The reference that settles it</div>
              {(() => {
                const [top, ...rest] = answer.rules;
                return (
                  <>
                    <div className="py-1.5" style={{ borderTop: `1px solid ${wash("--border", 30)}` }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{top!.text}</div>
                      <div className="text-[10.5px] mt-0.5" style={{ color: "var(--text4)" }}>
                        {top!.src} · {top!.cls}
                        {top!.backed > 0
                          ? ` · ${top!.backed.toLocaleString()} of your cases are in this class`
                          : " · nothing of yours recorded in this class yet"}
                      </div>
                    </div>
                    {rest.length > 0 && (
                      <>
                        <div className="text-[10px] tracking-wide uppercase mt-2.5" style={{ color: "var(--text4)" }}>Further references</div>
                        {rest.map((r) => (
                          <div key={r.id} className="py-1.5" style={{ borderTop: `1px solid ${wash("--border", 30)}` }}>
                            <div style={{ fontSize: 12.5, color: "var(--text)" }}>{r.text}</div>
                            <div className="text-[10.5px] mt-0.5" style={{ color: "var(--text4)" }}>
                              {r.src} · {r.cls}
                              {/* "in this class", NOT "behind it", and the difference is
                                  the whole honesty of the line. This number is how many
                                  precedents the CLASS holds, not how many support this
                                  particular rule — so it is identical on every rule of a
                                  class, and reading "6,809 cases behind it" under five
                                  different rules is how that was noticed. Counting real
                                  support per rule needs a matcher this does not have. */}
                              {r.backed > 0
                                ? ` · ${r.backed.toLocaleString()} of your cases are in this class`
                                : " · nothing of yours recorded in this class yet"}
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {/* Two sections, because they are two different claims. A note is a
              conclusion somebody reached; a transcript turn is what they said
              in the middle of doing something, and most of those are questions.
              Under one heading the second borrows the authority of the first —
              which is how "Complete the merge" ended up presented as a decision
              about squashing. */}
          {answer.decided.length > 0 && (
            <div className="px-4 pt-3">
              <div className="text-[10px] tracking-wide uppercase" style={{ color: "var(--text4)" }}>Recorded on the day</div>
              {answer.decided.map((p) => (
                <div key={p.id} className="py-1.5" style={{ borderTop: `1px solid ${wash("--border", 30)}` }}>
                  <div style={{ fontSize: 12.5, color: "var(--text)" }}>{p.hisWords || p.decision}</div>
                  <div className="text-[10.5px] mt-0.5" style={{ color: "var(--text4)" }}>
                    {p.situation} · {when(p.at)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {answer.said.length > 0 && (
            <div className="px-4 pt-3 pb-4">
              <div className="text-[10px] tracking-wide uppercase" style={{ color: "var(--text4)" }}>Said at the time</div>
              <p className="m-0 mb-1 text-[10.5px]" style={{ color: "var(--text4)" }}>
                Out of transcripts. This is how you talked about it, not something you settled.
              </p>
              {answer.said.map((p) => (
                <div key={p.id} className="py-1.5" style={{ borderTop: `1px solid ${wash("--border", 30)}` }}>
                  <div style={{ fontSize: 12.5, color: "var(--text2)" }}>{p.hisWords || p.decision}</div>
                  <div className="text-[10.5px] mt-0.5" style={{ color: "var(--text4)" }}>{when(p.at)}</div>
                </div>
              ))}
            </div>
          )}

          {/*
            * The judge, and it only ever appears where counting failed.
            *
            * Kept visually separate from everything above it because it is a
            * different KIND of claim: the rules and precedents are things he
            * wrote, quoted; this is a model's reading of them. Presenting the
            * two in one voice would let the second borrow the authority of the
            * first, which is the failure this whole panel is arranged against.
            */}
          {verdict && !verdict.declined && (
            <div className="px-4 py-3" style={{ borderTop: edge(10), background: wash("--warning", 6) }}>
              <div className="panel-eyebrow">Nothing of yours covered this — a reading of what you would do</div>
              <div style={{ fontSize: 12.5, color: "var(--text)" }}>{verdict.answer}</div>
              {verdict.why && (
                <div className="text-[11px] mt-1" style={{ color: "var(--text3)" }}>{verdict.why}</div>
              )}
              <div className="text-[10.5px] mt-1.5" style={{ color: "var(--text4)" }}>
                This one is not a quote. It was written by a model reading your rules and cases, so it can be
                wrong in a way the lines above cannot.
              </div>
            </div>
          )}

          {answer.thin && (
            <div className="px-4 py-3 text-[11.5px] leading-relaxed" style={{ color: "var(--text3)" }}>
              It would rather say nothing than reach.{" "}
              {(() => {
                const other = SIDES.find((s) => s.id !== side);
                const n = other ? banked[other.id] ?? 0 : 0;
                return n > 0 ? (
                  <>
                    <b style={{ fontWeight: 400 }}>{other!.label}</b> holds {n.toLocaleString()} rows — if this belongs
                    to that side of your work, ask there.
                  </>
                ) : (
                  <>The material it needs may be in a source you have not let it read.</>
                );
              })()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
