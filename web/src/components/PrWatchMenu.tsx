/*
 * The bell in a pull request's header: "tell me when this PR's CI does X".
 *
 * Three cards (the fixed rules, each with a live "Now" line) and the run as one
 * picture: a square per check, gathered by family. A family label or a square
 * decides what "Everything is green" does not wait for, and a square can also
 * ask to hear if it fails. The rules live on the server (server/src/prNotifyWatch.ts)
 * so they keep watching with the window closed; this only shows them and edits
 * them, through the same store the board reads (prWatchStore.ts) — one datum, two views.
 *
 * A one-shot rule turns itself off after it fires and the bell then shows what
 * it said; `Someone comments` is the exception and stays on, because comments keep coming.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PrCheck, PrComment, PrReview, PrWatchRule } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { ago } from "../lib/fileRecents.ts";
import { CommentIcon, DoneIcon, SearchIcon, SparkleIcon, UndoIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { placePop } from "../lib/prWatchPlace.ts";
import {
  bellState, checkFamilies, ciPassRule, failRuleOf, firedLabel, firedOk, fmtMs, ignoredOf, markFireSeen, presetOf, ruleLabel, runChecks,
  sameRule, splitCheck, suggestSkips, toggleIgnored, useFireSeen, usePrWatchState, waitTally, watchPhase, watchesOf, type RunCheck, type RunState,
} from "../lib/prWatchStore.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { BellIcon } from "./settingsNavIcons.tsx";
import { Button } from "./workspace/Chrome.tsx";

const STATE_WORDS: Record<RunState, string> = { pass: "passed", fail: "failed", run: "running", queue: "queued", skip: "doesn't run on this PR" };
const SHOWN_HITS = 5;

const Tick = ({ small }: { small?: boolean }) => (
  <svg width={small ? 9 : 11} height={small ? 9 : 11} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 6.2 5 8.5l4.5-5" /></svg>
);

function Hit({ q, name }: { q: string; name: string }) {
  const part = (t: string) => {
    const i = q ? t.toLowerCase().indexOf(q) : -1;
    return i < 0 ? t : <>{t.slice(0, i)}<mark>{t.slice(i, i + q.length)}</mark>{t.slice(i + q.length)}</>;
  };
  const sp = splitCheck(name);
  return sp ? <>{part(sp.arg)} <span className="pw-rest">{part(sp.family)}</span></> : <>{part(name)}</>;
}

export function PrWatchMenu({ root, repo, d, iconOnly }: {
  root: string; repo: string;
  /** The header draws the idle bell as an icon; a watch that is on or has fired keeps its words, because they are the news. */
  iconOnly?: boolean;
  d: { number: number; title: string; checksSha?: string; headSha?: string; checksAll: PrCheck[]; checks?: { allDone: boolean }; comments?: PrComment[]; reviews?: PrReview[] };
}) {
  const state = usePrWatchState();
  const mine = watchesOf(state, repo, d.number);
  const seen = useFireSeen(repo, d.number);
  const bell = bellState(mine, seen, d.checks?.allDone ?? true);
  const preset = presetOf(state, repo);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [bubble, setBubble] = useState<{ name: string; x: number; y: number; ax: number } | null>(null);
  const [skipped, setSkipped] = useState<string[] | null>(null);
  const [roving, setRoving] = useState(0);
  const [place, setPlace] = useState({ up: false, maxHeight: 9999, tight: false });
  const box = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useDismiss(open, box, () => { setOpen(false); setBubble(null); });

  const live = mine.filter((w) => w.active);
  const waiting = (r: PrWatchRule) => live.find((w) => sameRule(w.rule, r));
  const fail = (r: { ok: boolean; error?: string }) => setErr(r.ok ? "" : r.error ?? "could not save that");

  /* The ignore list as the person has it on screen: what they pressed, until the server's own copy says the same.
     Pressing a square while "Everything is green" is off only stages it; turning the card on sends it. */
  const [staged, setStaged] = useState<string[] | null>(null);
  const serverIgnored = ignoredOf(mine);
  const ignored = staged ?? serverIgnored;
  useEffect(() => { if (staged && staged.join("\n") === serverIgnored.join("\n")) setStaged(null); }, [staged, serverIgnored]);

  const current = live.map((w) => w.rule);
  /* The repo's default follows the cards while "Same for my new PRs" is on: every change re-saves it. */
  const follow = (next: PrWatchRule[]) => { if (preset?.auto) void api.prWatchPreset(root, next, true).then(fail); };
  const withoutRule = (r: PrWatchRule) => current.filter((x) => !sameRule(x, r));

  const toggleCard = async (r: PrWatchRule) => {
    const w = waiting(r);
    const rule = r.type === "ci-pass" ? ciPassRule(ignored) : r;
    fail(w ? await api.prWatchRemove(w.id) : await api.prWatchAdd(root, d.number, d.title, rule));
    follow(w ? withoutRule(r) : [...current, rule]);
  };
  const setIgnored = (next: string[]) => {
    setStaged(next);
    if (waiting({ type: "ci-pass" })) {
      void api.prWatchAdd(root, d.number, d.title, ciPassRule(next)).then(fail);
      follow([...withoutRule({ type: "ci-pass" }), ciPassRule(next)]);
    }
  };
  const ignoreMany = (names: string[], on: boolean) =>
    setIgnored(on ? [...ignored, ...names.filter((n) => !ignored.includes(n))] : ignored.filter((n) => !names.includes(n)));

  const isFailWatch = (name: string) => live.some((w) => sameRule(w.rule, failRuleOf(name)));
  const toggleWatch = async (name: string) => {
    const w = live.find((x) => sameRule(x.rule, failRuleOf(name)));
    fail(w ? await api.prWatchRemove(w.id) : await api.prWatchAdd(root, d.number, d.title, failRuleOf(name)));
    follow(w ? withoutRule(failRuleOf(name)) : [...current, failRuleOf(name)]);
  };

  const checks = useMemo(() => runChecks(d.checksAll), [d.checksAll]);
  const names = useMemo(() => new Set(checks.map((c) => c.name)), [checks]);
  const fams = useMemo(() => checkFamilies(checks), [checks]);
  const flat = useMemo(() => fams.flatMap((f) => f.members), [fams]);
  const tally = waitTally(checks, ignored);
  const failedNow = checks.filter((c) => c.state === "fail").length;
  const suggest = useMemo(() => suggestSkips(checks, preset?.rules.flatMap((r) => (r.type === "ci-pass" ? r.ignore ?? [] : [])) ?? []), [checks, preset]);
  const toSkip = suggest.filter((n) => !ignored.includes(n));
  const reqOf = (n: string) => checks.find((c) => c.name === n)?.required;
  const allNotRequired = toSkip.every((n) => reqOf(n) === false);
  /* By-name rules the map cannot draw as a ring: a name this run does not have, or "passes"/"either". */
  const otherRules = live.filter((w) => w.rule.type === "check" && !(w.rule.on === "fail" && names.has(w.rule.match)));

  const said = [...(d.comments ?? []).map((c) => Date.parse(c.createdAt)), ...(d.reviews ?? []).map((r) => Date.parse(r.submittedAt))].filter((t) => t > 0);
  const lastSaid = said.length ? Math.max(...said) : 0;

  const query = q.trim().toLowerCase();
  const hits = query ? flat.filter((c) => c.name.toLowerCase().includes(query)) : [];
  const phase = watchPhase(mine);
  /* The commit these squares are from: the detail's own, else what the watch last read. */
  const head = (d.checksSha || d.headSha || mine.find((w) => w.head)?.head)?.slice(0, 7);

  // Room under (or over) the button, measured when it opens and when the window resizes — an event, no polling.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => { if (box.current) setPlace(placePop(box.current.getBoundingClientRect(), window.innerHeight, [...document.querySelectorAll("[data-floating-furniture]")].map((e) => e.getBoundingClientRect()))); };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);
  useEffect(() => { if (open) search.current?.focus({ preventScroll: true }); }, [open]);
  /* The hits sit under the map, below the fold of a tall run: typing brings them into view, or the answer is off screen. */
  useEffect(() => { if (query) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }); }, [query, hits.length]);

  // The bubble sits under its square, measured inside the scrolling body.
  const pick = (name: string, el: HTMLElement) => {
    const body = bodyRef.current;
    if (!body) return;
    const br = body.getBoundingClientRect(), er = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(br.width - 264, er.left - br.left - 20));
    setBubble({ name, x, y: er.bottom - br.top + body.scrollTop + 9, ax: er.left - br.left - x + 1 });
  };
  /* Escape takes the bubble down first. The window hears it before useDismiss does, so one press closes one thing. */
  useEffect(() => {
    if (!bubble) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setBubble(null);
      bodyRef.current?.querySelector<HTMLElement>(`[data-n="${CSS.escape(bubble.name)}"]`)?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [bubble]);
  const onMapKey = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "Home" ? -Infinity : e.key === "End" ? Infinity : 0;
    if (!step) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(flat.length - 1, step === -Infinity ? 0 : step === Infinity ? flat.length - 1 : roving + step));
    setRoving(next);
    bodyRef.current?.querySelector<HTMLElement>(`[data-i="${next}"]`)?.focus();
  };

  const saveDefault = async (on: boolean) => {
    /* With nothing on, "on" saves an empty default: new PRs start with no rules, and the switch still means something. */
    const rules = on ? (current.length ? current : preset?.rules ?? []) : preset?.rules ?? current;
    fail(await api.prWatchPreset(root, rules, on));
  };

  const label = bell.kind === "on" ? (phase?.kind === "waiting" ? "Waiting for new run" : `Watching ${bell.waiting}`) : bell.kind === "fired" && bell.last ? firedLabel(bell.last) : "Notify";
  const tone = bell.kind === "on" ? "primary" : bell.kind === "fired" ? "ok" : "plain";
  const title = bell.kind === "off" && !bell.last?.lastText ? "Notify me when CI passes, fails, or someone comments"
    : bell.kind === "on" && phase ? phase.text
    : bell.last?.lastText ? `Last: ${bell.last.lastText}` : "Watching this pull request";

  const bubbleCheck = bubble ? flat.find((c) => c.name === bubble.name) : undefined;
  const card = (rule: PrWatchRule, hue: string, icon: React.ReactNode, tt: string, ex: string, now: React.ReactNode) => (
    <button type="button" role="switch" aria-checked={!!waiting(rule)} className="pw-card" style={{ "--hue": hue } as React.CSSProperties}
      onClick={() => void toggleCard(rule)} data-pr-watch-card={rule.type}>
      <span className="pw-ic">{icon}</span>
      <span className="pw-tx"><span className="pw-tt">{tt}</span><span className="pw-ex">{ex}</span><span className="pw-now"><span className="pw-lbl">Now</span>{now}</span></span>
      <span className="pw-tick"><Tick /></span>
    </button>
  );
  const pct = (n: number) => `${tally.waitFor ? (n / tally.waitFor) * 100 : 0}%`;

  return (
    <div className="relative shrink-0 flex" ref={box}>
      <Button size={iconOnly ? "hit" : "compact"} square={iconOnly && bell.kind === "off"} label={iconOnly && bell.kind === "off" ? "Notify" : undefined}
        tone={tone} title={title} aria-haspopup="true" aria-expanded={open}
        data-pr-watch={bell.kind} onClick={() => {
          setOpen((v) => !v);
          setBubble(null);
          // Opening it is looking at it: the fire has been seen, the button goes back to Notify.
          if (bell.kind === "fired" && bell.last?.lastAt) markFireSeen(repo, d.number, bell.last.lastAt);
        }}>
        {bell.kind === "fired" && bell.last ? (firedOk(bell.last) ? <DoneIcon size={ICON.xs} /> : <WarningIcon size={ICON.xs} />) : <BellIcon size={ICON.xs} />}{iconOnly && bell.kind === "off" ? null : label}
      </Button>
      {open && (
        <div className="pw-pop" role="group" aria-label="Notify me about this pull request" data-pr-watch-menu data-up={place.up ? "" : undefined} data-tight={place.tight ? "" : undefined}
          style={{ maxHeight: place.maxHeight, ...(place.up ? { bottom: "100%", marginBottom: 6 } : { top: "100%", marginTop: 6 }) }}>
          <div className="pw-body" ref={bodyRef}>
            <div className="pw-q">Tell me when…<small>#{d.number}</small></div>
            <div className="pw-cards">
              {card({ type: "ci-pass" }, "var(--success)", <DoneIcon size={ICON.md} />, "Everything is green",
                ignored.length ? `Once the ${tally.waitFor} checks I wait for have all passed.` : "Once every check on this run has passed.",
                <>
                  <span className="pw-meter" aria-hidden="true">
                    <i style={{ width: pct(tally.pass), background: "var(--success)" }} /><i style={{ width: pct(tally.run), background: "var(--warning)" }} /><i style={{ width: pct(tally.fail), background: "var(--error)" }} />
                  </span>
                  <span>{tally.pass}/{tally.waitFor} green · {tally.run} running{tally.reqSkipped > 0 && <b style={{ color: "var(--warning-ink)", fontWeight: 500 }}> · {tally.reqSkipped} required not waited for</b>}</span>
                </>)}
              {card({ type: "ci-fail" }, "var(--error)", <WarningIcon size={ICON.md} />, "Something fails", "The first failure, then this turns itself off.",
                failedNow ? <span><b style={{ color: "var(--error-ink)", fontWeight: 500 }}>{failedNow} already failed</b> <span style={{ color: "var(--text3)" }}>· you'd hear the next</span></span> : <span>nothing has failed yet</span>)}
              {card({ type: "comment" }, "var(--info)", <CommentIcon size={ICON.md} />, "Someone comments", "Every new comment or review, until I turn it off.",
                <span>{lastSaid ? `last one ${ago(lastSaid)} · ` : ""}{said.length} on this PR</span>)}
            </div>

            <div className="pw-run">
              <div className="pw-runh">
                <b>This run</b>
                <span className="pw-meta">
                  {head && <><code>{head}</code> · </>}{checks.length} checks
                  {ignored.length > 0 && <> · <span style={{ color: "var(--text2)" }}>not waiting for {ignored.length}{waiting({ type: "ci-pass" }) ? "" : " (staged)"}</span></>}
                  {checks.filter((c) => isFailWatch(c.name)).length > 0 && <> · watching {checks.filter((c) => isFailWatch(c.name)).length}</>}
                </span>
              </div>
              {phase && phase.kind !== "watching" && <div className="pw-meta" style={{ marginBottom: 8 }} data-pr-watch-phase={phase.kind}>{phase.text}</div>}
              {checks.length === 0 ? <div className="pw-meta">No checks on this pull request yet</div> : (
                <div className="pw-map" role="group" aria-label="Checks on this run" onKeyDown={onMapKey}>
                  {fams.map((f) => {
                    const allOff = f.members.every((c) => ignored.includes(c.name));
                    return (
                      <div key={f.key} className="pw-fam" data-off={allOff ? "" : undefined} style={{ "--w": f.key === "other jobs" ? "380px" : `${Math.max(f.members.length, 3) * 16}px` } as React.CSSProperties}>
                        <button type="button" className="pw-fn" aria-pressed={allOff} title={`${allOff ? "Wait for" : "Don't wait for"} every ${f.key} check`}
                          onClick={() => ignoreMany(f.members.map((c) => c.name), !allOff)}>{f.key} <i>{f.members.length}</i></button>
                        <div className="pw-dots">
                          {f.members.map((c) => {
                            const i = flat.indexOf(c);
                            const off = ignored.includes(c.name);
                            return (
                              <button key={c.name} type="button" className="pw-d" data-s={c.state} data-n={c.name} data-i={i} data-req={c.required === true ? "" : undefined}
                                data-off={off ? "" : undefined} data-watch={isFailWatch(c.name) ? "" : undefined} data-sel={bubble?.name === c.name ? "" : undefined}
                                data-dim={query && !c.name.toLowerCase().includes(query) ? "" : undefined}
                                tabIndex={i === roving ? 0 : -1} title={`${c.name} — ${STATE_WORDS[c.state]}${c.required === true ? " · required to merge" : ""}`}
                                aria-label={`${c.name}, ${STATE_WORDS[c.state]}${c.required === true ? ", required to merge" : ""}${off ? ", not waiting for it" : ""}${isFailWatch(c.name) ? ", tell me if it fails" : ""}`}
                                aria-haspopup="true" aria-expanded={bubble?.name === c.name}
                                onClick={(e) => { setRoving(i); if (bubble?.name === c.name) setBubble(null); else pick(c.name, e.currentTarget); }} />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {skipped ? (
                <div className="pw-done"><DoneIcon size={ICON.sm} /><span>Not waiting for the {skipped.length} that never run here or are skipped on their own.</span>
                  <button type="button" className="pw-link" onClick={() => { ignoreMany(skipped, false); setSkipped(null); }}><UndoIcon size={ICON.xs} />Undo</button></div>
              ) : toSkip.length > 0 && (
                <div className="pw-sug">
                  <span className="pw-spark"><SparkleIcon size={ICON.sm} /></span>
                  <span className="pw-st"><b>{allNotRequired
                    ? `${toSkip.length} check${toSkip.length === 1 ? "" : "s"} don't block merging and can hold up the green light`
                    : `${toSkip.length} check${toSkip.length === 1 ? "" : "s"} didn't run here / flip on their own — stop waiting for them?`}</b><span>{toSkip.slice(0, 4).join(" · ")}{toSkip.length > 4 ? "…" : ""}</span></span>
                  <Button size="compact" tone="primary" onClick={() => { ignoreMany(toSkip, true); setSkipped(toSkip); }}>Skip them</Button>
                </div>
              )}

              <label className="pw-search"><SearchIcon size={ICON.sm} />
                <input ref={search} value={q} placeholder="Find a check by name" aria-label="Find a check by name" onChange={(e) => setQ(e.target.value)} />
                {query && <span className="pw-n">{hits.length} found</span>}
              </label>
              {query ? (hits.length === 0 ? (
                <>
                  <div className="pw-empty"><b>Nothing called “{q.trim()}” on this run</b>It may not have started yet.</div>
                  <div className="pw-name"><BellIcon size={ICON.sm} /><span>Tell me if a check named <code>{q.trim()}</code>… fails</span>
                    <Button size="compact" className="ml-auto" onClick={() => { void api.prWatchAdd(root, d.number, d.title, failRuleOf(q.trim())).then(fail); setQ(""); }}>Watch for it</Button></div>
                </>
              ) : (
                <div className="pw-hits">
                  {hits.slice(0, SHOWN_HITS).map((c) => <HitRow key={c.name} c={c} q={query} off={ignored.includes(c.name)} watched={isFailWatch(c.name)}
                    onIgnore={() => setIgnored(toggleIgnored(ignored, c.name))} onWatch={() => void toggleWatch(c.name)} />)}
                  {hits.length > SHOWN_HITS && (
                    <div className="pw-more">{hits.length - SHOWN_HITS} more lit up in the map
                      <button type="button" className="pw-link" data-end onClick={() => ignoreMany(hits.map((c) => c.name), true)}>Don't wait for all {hits.length}</button></div>
                  )}
                </div>
              )) : otherRules.length > 0 ? (
                <div className="pw-hits">
                  {otherRules.map((w) => (
                    <div key={w.id} className="pw-row"><BellIcon size={ICON.xs} /><span className="pw-hn" title={ruleLabel(w.rule)}>{ruleLabel(w.rule)}</span>
                      <button type="button" className="pw-chip" onClick={() => void api.prWatchRemove(w.id).then(fail)}>Remove</button></div>
                  ))}
                </div>
              ) : (
                <div className="pw-legend">
                  <span><i className="pw-d" data-s="pass" />passed</span><span><i className="pw-d" data-s="run" />running</span><span><i className="pw-d" data-s="fail" />failed</span>
                  <span><i className="pw-d" data-off="" data-s="pass" />not waiting</span><span><i className="pw-d" data-s="pass" data-watch="" />tell me if it fails</span><span><i className="pw-d" data-s="pass" data-req="" />required</span>
                </div>
              )}
              {(bell.last?.lastText || err) && (
                <div className="pw-meta" style={{ marginTop: 8, ...(err ? { color: "var(--error-ink)" } : null) }}>{err || `Last: ${bell.last!.lastText}`}</div>
              )}
            </div>

            {bubble && bubbleCheck && (
              <div className="pw-bub" role="group" aria-label={bubbleCheck.name} style={{ left: bubble.x, top: bubble.y, "--ax": `${bubble.ax}px` } as React.CSSProperties}>
                <div className="pw-bn">{bubbleCheck.name}</div>
                <div className="pw-bs">{STATE_WORDS[bubbleCheck.state]}{bubbleCheck.ms ? ` · ${fmtMs(bubbleCheck.ms)}` : ""}</div>
                {bubbleCheck.required === true && <div className="pw-bs pw-req">Required to merge — the PR can't merge without it</div>}
                <button type="button" role="checkbox" aria-checked={ignored.includes(bubbleCheck.name)} onClick={() => setIgnored(toggleIgnored(ignored, bubbleCheck.name))}>
                  <span className="pw-bx"><Tick small /></span>Don't wait for it</button>
                <button type="button" role="checkbox" aria-checked={isFailWatch(bubbleCheck.name)} onClick={() => void toggleWatch(bubbleCheck.name)}>
                  <span className="pw-bx"><Tick small /></span>Tell me if it fails</button>
              </div>
            )}
          </div>
          <div className="pw-foot">
            <button type="button" role="switch" className="pw-sw" aria-checked={!!preset?.auto} aria-label={`Same for my new PRs in ${repo}`}
              title={`New PRs you open in ${repo} start with these choices`}
              onClick={() => void saveDefault(!preset?.auto)} />
            <span>Same for my new PRs in <b>{repo}</b></span>
          </div>
        </div>
      )}
    </div>
  );
}

function HitRow({ c, q, off, watched, onIgnore, onWatch }: { c: RunCheck; q: string; off: boolean; watched: boolean; onIgnore: () => void; onWatch: () => void }) {
  return (
    <div className="pw-row">
      <i className="pw-d" data-s={c.state} />
      <span className="pw-hn" title={c.name}><Hit q={q} name={c.name} /></span>
      <button type="button" className="pw-chip" aria-pressed={off} onClick={onIgnore}>Don't wait</button>
      <button type="button" className="pw-chip" data-al="" aria-pressed={watched} onClick={onWatch}><BellIcon size={ICON.xs} />If it fails</button>
    </div>
  );
}
