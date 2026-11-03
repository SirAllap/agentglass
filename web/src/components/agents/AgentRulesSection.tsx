import { GlobeIcon } from "../browser/icons.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { BASE_PROJECT, MODE_ACTION, type AgentRule, type AgentRulesView, type RuleRemoveRequest, type RuleRequest, type RuleSetting } from "../../../../shared/agentRules.ts";
import type { LaunchMode } from "../../../../shared/launchModes.ts";
import { projectLabel } from "../../lib/agentsScreen.ts";
import {
  MODE_CHOICES, actionKeyOf, baseOrder, baseSummary, blockedBy, fullAccessOn, fullAccessRemovals, fullAccessRequests, isUnder, newRuleRequest, ruleCode, ruleIcon, ruleTitle, ruleTotals, ruleWhen, rowRequest, sourceChip,
  splitLearned, suggestionPhrase, type HeldCall,
} from "../../lib/agentRulesView.ts";
import { growthBars } from "../../lib/weeklyStrip.ts";
import { tipAttr } from "../../lib/tip.ts";
import { ICON } from "../../lib/iconSize.ts";
import { Ph } from "./phosphor.tsx";
import { NewBadge, SubLine } from "./AgentsSections.tsx";
import { Button, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";

/*
 * "WHAT YOUR AGENTS MAY DO": one card per project, drawn from the rules store
 * (shared/agentRules.ts, GET /agent-rules).
 *
 * Each card is the project's rules newest first, the suggestions an agent's
 * first try left behind, the base set every project shares, and the strip of
 * how the list grew. Allow / Ask me / Never is a write to the same route the
 * `agentglass-ui rules set` door uses; a suggestion is answered on its own
 * route, and only the person answers. A stricter change by an agent applied at
 * once and a looser one waits as a card in "Waiting on you"; the row keeps the
 * rule as it is until that card is answered.
 *
 * The data is read on this screen's own clock: every project's rules every
 * 30 s while the screen is on show (a local SQL read each, so three projects
 * are 360 requests an hour), and again at once after any click here.
 */

const REFRESH_MS = 30_000;

interface Props {
  /** The project the screen is looking at, or "" for every project. */
  root: string;
  projects: readonly string[];
  /** The agent behind a held call's session: its name, for "builder-1 is waiting", and the checkout it works in, to know which project's rule it waits on. */
  who: (session: string) => { name: string; worktree?: string } | undefined;
  gates: readonly HeldCall[];
  active: boolean;
  now: number;
  /** The first-run page: the base set in one line, and "Review rules" for the rest. */
  compact?: boolean;
}

export function AgentRulesSection({ root, projects, who, gates, active, now, compact }: Props) {
  const all = root === "";
  const roots = useMemo(() => (all ? [...projects] : [root]), [all, root, projects]);
  const [views, setViews] = useState<Record<string, AgentRulesView>>({});
  const [error, setError] = useState("");
  const [review, setReview] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const key = roots.join("\n");
  const load = useCallback(async () => {
    const got = await Promise.all(roots.map((r) => api.agentRules(r).catch(() => ({ ok: false as const, error: "could not read the rules" }))));
    if (!live.current) return;
    const next: Record<string, AgentRulesView> = {};
    got.forEach((g, i) => { if (g.ok && g.base && g.learned && g.suggested && g.weekly) next[roots[i]!] = g as AgentRulesView; });
    setViews(next);
    setError(got.find((g) => !g.ok)?.error ?? "");
  // roots is derived from key
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!active || roots.length === 0) return;
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [active, load, roots.length]);

  const first = views[roots[0] ?? ""];
  const head = (
    <>
      <div className="sh">
        <h2>What your agents may do</h2>
        {!compact && <NewBadge />}
        <span className="sp" />
        {!compact && <span className="hint">every project learns its own rules as you work</span>}
      </div>
      <SubLine src="Settings, Agents" icon="gear" notify={compact ? undefined : "now"} notifyText="Only an agent blocked on a rule notifies you" />
    </>
  );

  if (compact) {
    const sum = first ? baseSummary(first.base, first.mode) : null;
    return (
      <div aria-label="What your agents may do">
        {head}
        <div className="fold" style={{ padding: "14px 16px", borderStyle: "solid", background: "var(--bg)", flexWrap: "nowrap" }}>
          <Ph name="check-circle" size={18} />
          <span>{sum ? <><b>{sum.lead}</b> {sum.rest}</> : <>Reading the rules.</>} It learns the rest as you work. <NewBadge /></span>
          <span className="sp" />
          <button type="button" className="btn sm" aria-expanded={review} onClick={() => setReview((v) => !v)}>{review ? "Hide rules" : "Review rules"}</button>
        </div>
        {review && <div style={{ marginTop: 14 }}><Cards roots={roots} views={views} all={all} single who={who} gates={gates} now={now} reload={load} /></div>}
        {error && <div className="err-line" role="alert" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    );
  }

  return (
    <section aria-label="What your agents may do">
      {head}
      <div className="learnhow">
        <span className="lab"><Ph name="sparkle" size={16} />Where a rule comes from</span>
        <div className="st"><span className="sc chat"><Ph name="chat-circle-text" size={13} />you said it in chat</span><span>You tell an agent in chat. It writes the rule at once.</span></div>
        <div className="st"><span className="sc first"><Ph name="sparkle" size={13} />seen for the first time</span><span>An agent had to ask you for something no rule covers. You get a suggestion.</span></div>
        <div className="st"><span className="sc always"><Ph name="check-circle" size={13} />you pressed Always allow here</span><span>You click Always allow here. The click becomes a rule.</span></div>
      </div>
      <div className="legend rules">
        <span><Ph name="check-circle" size={14} />Rules reach agents agentglass started</span>
        <span><Ph name="check-circle" size={14} />and your own sessions <NewBadge /></span>
        <span style={{ flex: 1 }} />
        <span>Stricter changes apply at once. Looser ones wait for your click.</span>
      </div>
      {error && <div className="err-line" role="alert" style={{ marginBottom: 10 }}>{error}</div>}
      <Cards roots={roots} views={views} all={all} single={roots.length === 1} who={who} gates={gates} now={now} reload={load} />
    </section>
  );
}

/* The base set is global: drawn once, above the project cards, never inside one. */
function BaseCard({ base, now, reload }: { base: AgentRulesView["base"]; now: number; reload: () => Promise<void> }) {
  const { err, busy, add, row } = useRuleRows(now, reload);
  return (
    <div className="pcard base" data-agent-rules-base>
      <div className="grp"><GlobeIcon size={14} />Base rules, the same in every project<span className="cnt">{base.length}</span><span className="sp" /><span className="m">tiny on purpose</span></div>
      <div className="older" style={{ borderTop: 0 }}>Applies to every project, including ones not listed below</div>
      {baseOrder(base).map((rule) => row(rule, { base: true }))}
      <AddRule root={BASE_PROJECT} where="in every project" add={add} busy={busy !== ""} />
      {err && <div className="err-line" role="alert" style={{ padding: "8px 18px" }}>{err}</div>}
    </div>
  );
}

/*
 * WRITING A RULE BY HAND. "Add a rule" opens a small form on the card it sits
 * in and posts to the door `agentglass-ui rules set` uses, scoped to that card:
 * the project's root, or `"*"` on the base card. The person's own write applies
 * at once and a card that is waiting on them says so; the row flow's error line
 * is the one place a failed write shows.
 *
 * `full` is the project cards' one-click access and is absent on the base card,
 * which is global: it covers projects this screen does not list.
 */
const NEW_RULE = "new rule";
const FULL_ACCESS = "full access";

function AddRule({ root, where, add, busy, full }: {
  root: string; where: string; add: (r: RuleRequest) => Promise<boolean>; busy: boolean;
  full?: { on: boolean; write: (on: boolean) => Promise<boolean> };
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="radd-t" style={{ flexWrap: "wrap", rowGap: 6 }}>
        <Button size="compact" tone="quiet" aria-expanded={open}
          data-tip={tipAttr({ name: open ? "Close the form" : "Add a rule", text: `Write one by hand ${where}.` })}
          onClick={() => setOpen((v) => !v)}>
          <Ph name="plus" size={ICON.xs} />Add a rule
        </Button>
        {full && <FullAccess on={full.on} write={full.write} busy={busy} />}
      </div>
      {open && <NewRuleForm root={root} where={where} add={add} busy={busy} onDone={() => setOpen(false)} />}
    </>
  );
}

/* The four rules in one click. The line beside it is the ceiling people trip on; the removal asks once, inline. */
function FullAccess({ on, write, busy }: { on: boolean; write: (on: boolean) => Promise<boolean>; busy: boolean }) {
  const [ask, setAsk] = useState(false);
  const remove = () => { void write(false).then((ok) => { if (ok) setAsk(false); }); };
  return (
    <>
      <Button size="compact" tone="quiet" disabled={busy} aria-expanded={on ? ask : undefined}
        data-tip={tipAttr(on
          ? { name: "Back to default", text: "Takes the four rules this button wrote out of this project." }
          : { name: "Full access for this repo", text: "Allows Bash, Edit, Write and git push --force-with-lease in this project only." })}
        onClick={() => { if (on) setAsk(true); else void write(true); }}>
        <Ph name="lightning" size={ICON.xs} />{on ? "Back to default" : "Full access for this repo"}
      </Button>
      {ask
        ? (
          <span role="group" aria-label="Remove the full-access rules" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--text2)" }}>
            Remove those four rules from this project?
            <Button size="compact" tone="danger" disabled={busy} onClick={remove}>Remove</Button>
            <Button size="compact" tone="quiet" disabled={busy} onClick={() => setAsk(false)}>Keep</Button>
          </span>
        )
        : <span style={{ fontSize: 11.5, color: "var(--text3)" }}>Narrower rules still win: a base Never or a learned rule on the same command still holds.</span>}
    </>
  );
}

function NewRuleForm({ root, where, add, busy, onDone }: {
  root: string; where: string; add: (r: RuleRequest) => Promise<boolean>; busy: boolean; onDone: () => void;
}) {
  const [pattern, setPattern] = useState("");
  const [name, setName] = useState("");
  const [setting, setSetting] = useState<RuleSetting>("ask");
  const named = actionKeyOf(name);
  const badName = name.trim() !== "" && named === "";
  const ready = pattern.trim() !== "" && !badName && !busy;
  const send = () => {
    if (!ready) return;
    void add(newRuleRequest(root, pattern, name, setting)).then((ok) => { if (ok) onDone(); });
  };
  const key = (e: { key: string; preventDefault: () => void }) => {
    if (e.key === "Enter") { e.preventDefault(); send(); } else if (e.key === "Escape") onDone();
  };
  return (
    <div className="radd" data-agent-rule-add={root}>
      <div className="r1">
        <Ph name="terminal-window" size={ICON.sm} />
        <input value={pattern} onChange={(e) => setPattern(e.target.value)} onKeyDown={key} spellCheck={false} autoFocus
          className={`flex-1 min-w-0 ${INPUT}`} style={INPUT_STYLE}
          placeholder="Bash(git push --force-with-lease:*)" aria-label={`Tool pattern of the new rule ${where}`} />
      </div>
      <div className="r2">
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={key} spellCheck={false}
          className={`min-w-0 ${INPUT}`} style={{ ...INPUT_STYLE, flex: "0 1 200px" }}
          placeholder="Name (optional)" aria-label={`Name of the new rule ${where}`} aria-invalid={badName || undefined}
          data-tip={tipAttr({ name: "Name", text: "The key this rule answers to, like ship.code. Empty, it is made from the pattern." })} />
        {badName
          ? <span className="bad" role="alert">a name starts with a letter, then letters, digits and dots</span>
          : named ? <span className="note">named {named}</span> : null}
        <span className="sp" />
        <Tri value={setting} label={`the new rule ${where}: what an agent may do`} busy={busy} onPick={setSetting} />
      </div>
      <div className="r3">
        <span className="note">{setting === "allow" ? "Runs without asking." : setting === "never" ? "The call is refused." : "You answer each call."}</span>
        <span className="sp" />
        <Button size="compact" tone="quiet" disabled={busy} onClick={onDone}>Cancel</Button>
        <Button size="compact" tone="primary" pending={busy} disabled={!ready} onClick={send}>Add the rule</Button>
      </div>
    </div>
  );
}

function Cards({ roots, views, all, single, who, gates, now, reload }: {
  roots: string[]; views: Record<string, AgentRulesView>; all: boolean; single?: boolean;
  who: Props["who"]; gates: readonly HeldCall[]; now: number; reload: () => Promise<void>;
}) {
  const shown = roots.filter((r) => views[r]);
  const base = shown[0] ? views[shown[0]]!.base : null;
  return (
    <>
    {base && <div style={{ marginBottom: 20 }}><BaseCard base={base} now={now} reload={reload} /></div>}
    <div className="pcards" style={single ? { gridTemplateColumns: "minmax(0, 1fr)" } : undefined}>
      {shown.map((r) => (
        <ProjectCard key={r} root={r} view={views[r]!} tag={all ? null : "this project"}
          who={who} gates={gates} now={now} reload={reload} />
      ))}
    </div>
    </>
  );
}

const SETTINGS: { v: RuleSetting; word: string; tone: "allow" | "ask" | "deny" }[] = [
  { v: "allow", word: "Allow", tone: "allow" }, { v: "ask", word: "Ask me", tone: "ask" }, { v: "never", word: "Never", tone: "deny" },
];

function Tri({ value, label, busy, onPick }: { value: RuleSetting | null; label: string; busy: boolean; onPick: (s: RuleSetting) => void }) {
  return (
    <div className="tri" role="group" aria-label={label}>
      {SETTINGS.map((o) => (
        <button key={o.v} type="button" className={value === o.v ? `on t-${o.tone}` : ""} aria-pressed={value === o.v} disabled={busy} onClick={() => value !== o.v && onPick(o.v)}>{o.word}</button>
      ))}
    </div>
  );
}

function useRuleRows(now: number, reload: () => Promise<void>) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const run = async (id: string, ...calls: (() => Promise<{ ok: boolean; error?: string; waitsForPerson?: boolean }>)[]): Promise<boolean> => {
    setBusy(id); setErr("");
    let ok = true;
    for (const fn of calls) {
      try {
        const r = await fn();
        if (!r.ok) { ok = false; setErr(r.error ?? "that did not go through"); }
      } catch { ok = false; setErr("that did not go through"); }
    }
    setBusy(""); await reload();
    return ok;
  };
  const write = (rule: AgentRule, setting: RuleSetting) => run(rule.id, () => api.agentRuleSet(rowRequest(rule, setting)));
  const answer = (rule: AgentRule, a: { setting: RuleSetting } | { dismiss: true }) => run(rule.id, () => api.agentRuleAnswer(rule.id, a));
  const add = (r: RuleRequest) => run(NEW_RULE, () => api.agentRuleSet(r));
  const fullAccess = (root: string, on: boolean) => {
    const requests: (RuleRequest | RuleRemoveRequest)[] = on ? fullAccessRequests(root) : fullAccessRemovals(root);
    return run(FULL_ACCESS, ...requests.map((r) => () => api.agentRuleSet(r)));
  };
  const setMode = (mode: LaunchMode) => run(MODE_ACTION, () => api.agentRuleSet({ root: "*", action: MODE_ACTION, match: "", setting: mode === "default" ? "ask" : "allow", mode }));

  const row = (rule: AgentRule, opts: { fresh?: boolean; base?: boolean; overrides?: boolean }) => {
    const chip = sourceChip(rule, opts.base);
    const mode = rule.action === MODE_ACTION;
    return (
      <div className={`lr${opts.fresh ? " fresh" : ""}`} key={rule.id}>
        <span className="ri"><Ph name={ruleIcon(rule)} size={15} /></span>
        <div>
          <div className="l1">
            <b>{ruleTitle(rule)}</b><code>{ruleCode(rule)}</code>
            {opts.fresh && <span className="fresh-t">learned this week</span>}
            {opts.overrides && <span className="agv-chip info">overrides the base rule</span>}
          </div>
          <div className="l2"><span className={`sc ${chip.kind === "plain" ? "" : chip.kind}`}><Ph name={chip.icon} size={13} />{chip.label}</span><span>{ruleWhen(rule, now, opts.base)}</span></div>
        </div>
        {mode
          ? (
            <div className="tri" role="group" aria-label="Permission mode">
              {MODE_CHOICES.map((c) => (
                <button key={c.mode} type="button" className={rule.mode === c.mode ? `on t-${c.mode === "default" ? "ask" : "allow"}` : ""} aria-pressed={rule.mode === c.mode}
                  disabled={busy === MODE_ACTION} onClick={() => rule.mode !== c.mode && void setMode(c.mode)}>{c.word}</button>
              ))}
            </div>
          )
          : <Tri value={rule.setting} label={`${ruleTitle(rule)}: what an agent may do`} busy={busy === rule.id} onPick={(s) => void write(rule, s)} />}
      </div>
    );
  };

  return { busy, err, run, answer, add, fullAccess, row };
}

function ProjectCard({ root, view, tag, who, gates, now, reload }: {
  root: string; view: AgentRulesView; tag: "this project" | null;
  who: Props["who"]; gates: readonly HeldCall[]; now: number; reload: () => Promise<void>;
}) {
  const [older, setOlder] = useState(false);
  const label = projectLabel(root);
  const totals = ruleTotals(view);
  const bars = growthBars(view.weekly, view.base.length, view.learned.length);
  /* Only the calls held in this project can be waiting on one of its suggestions. */
  /* Only the calls held in this project can be waiting on one of its suggestions. */
  const held = gates.filter((g) => { const w = who(g.session_id)?.worktree; return !!w && isUnder(w, root); });
  const nameOf = (session: string) => who(session)?.name;
  const { shown, older: rest } = splitLearned(view.learned, now);
  const listed = older ? [...shown, ...rest] : shown;

  const { busy, err, answer, add, fullAccess, row } = useRuleRows(now, reload);
  return (
    <div className="pcard" data-agent-rules-project={root}>
      <div className="ph">
        <div>
          <div className="nm"><Ph name="folder-simple" size={17} />{label}{tag && <span className={`agv-chip${tag === "this project" ? " info" : ""}`}>{tag}</span>}</div>
          <div className="tot"><b>{totals.total}</b>rules: {totals.base} base + {totals.learned} learned, <span style={{ color: totals.week ? "var(--success)" : "var(--text3)", fontWeight: 700 }}>+{totals.week}</span> this week</div>
        </div>
        <div>
          <div className="gr">
            {bars.map((b, i) => (
              <div key={i} className={`c${b.current ? " now" : ""}`} title={`${b.total} rules`}>
                <i className="l" style={{ height: b.learnedPx }} /><i className="b" style={{ height: b.basePx }} />
              </div>
            ))}
          </div>
          <div className="grl"><span>8 weeks ago</span><span>now</span></div>
        </div>
      </div>

      {view.suggested.length > 0 && (
        <>
          <div className="grp"><Ph name="sparkle" size={14} />Suggested<span className="cnt warn">{view.suggested.length}</span><span className="sp" /><span className="m">quiet unless an agent is blocked on one</span></div>
          {view.suggested.map((rule) => {
            const who = blockedBy(rule, root, held, nameOf);
            const chip = sourceChip(rule);
            return (
              <div className={`sug${who ? " blk" : ""}`} key={rule.id}><div className="rail" /><div className="in">
                <div className="t">
                  <b>New in {label}: {suggestionPhrase(rule)}</b><span className="sp" />
                  <span className={`sc ${chip.kind === "plain" ? "" : chip.kind}`}><Ph name={chip.icon} size={13} />{chip.label}</span>
                </div>
                <div className="row" style={{ gap: 10 }}>
                  <span className="code" style={{ fontSize: 12 }}>{ruleCode(rule)}</span>
                  {who
                    ? <span className="nf now"><Ph name="bell-ringing" size={13} />{who} is waiting, notifies you</span>
                    : <span className="nf quiet"><Ph name="bell-simple-slash" size={13} />Quiet badge, nobody is waiting</span>}
                </div>
                <div className="acts">
                  <button type="button" className="btn sm primary" disabled={busy === rule.id} onClick={() => void answer(rule, { setting: "allow" })}>Allow</button>
                  <button type="button" className="btn sm" disabled={busy === rule.id} onClick={() => void answer(rule, { setting: "ask" })}>Ask me</button>
                  <button type="button" className="btn sm stop" disabled={busy === rule.id} onClick={() => void answer(rule, { setting: "never" })}>Never</button>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="btn sm quiet sq dismiss" aria-label="Dismiss this suggestion" title="Dismiss, and do not suggest it again"
                    disabled={busy === rule.id} onClick={() => void answer(rule, { dismiss: true })}><Ph name="x" size={13} /></button>
                </div>
              </div></div>
            );
          })}
        </>
      )}

      <div className="grp"><Ph name="list-checks" size={14} />Learned in this project<span className="cnt">{view.learned.length}</span><span className="sp" /><span className="m">newest first</span></div>
      {view.learned.length === 0 && <div className="older">Nothing learned yet</div>}
      {listed.map((l) => row(l.rule, { fresh: l.fresh, overrides: view.base.some((b) => b.action === l.rule.action) }))}
      {rest.length > 0 && (
        <div className="older">
          <Ph name="eye-slash" size={15} /><b>{rest.length}</b> older learned rules<span style={{ flex: 1 }} />
          <button type="button" className="btn sm" aria-expanded={older} onClick={() => setOlder((v) => !v)}>{older ? "Hide" : "Show"}</button>
        </div>
      )}

      <AddRule root={root} where={`in ${label}`} add={add} busy={busy !== ""}
        full={{ on: fullAccessOn(view.learned), write: (on) => fullAccess(root, on) }} />

      {err && <div className="err-line" role="alert" style={{ padding: "8px 18px" }}>{err}</div>}
    </div>
  );
}
