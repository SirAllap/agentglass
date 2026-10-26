import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { MODE_ACTION, type AgentRule, type AgentRulesView, type RuleSetting } from "../../../../shared/agentRules.ts";
import type { LaunchMode } from "../../../../shared/launchModes.ts";
import { projectLabel } from "../../lib/agentsScreen.ts";
import {
  MODE_CHOICES, baseOrder, baseSummary, blockedBy, isUnder, ruleCode, ruleIcon, ruleTitle, ruleTotals, ruleWhen, rowRequest, sourceChip,
  splitLearned, suggestionPhrase, type HeldCall,
} from "../../lib/agentRulesView.ts";
import { growthBars } from "../../lib/weeklyStrip.ts";
import { Ph } from "./phosphor.tsx";
import { NewBadge, SubLine } from "./AgentsSections.tsx";

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
  const roots = useMemo(() => (all ? [...projects] : [root, ...projects.filter((p) => p !== root)]), [all, root, projects]);
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
        <div className="st"><span className="sc first"><Ph name="sparkle" size={13} />seen for the first time</span><span>An agent does something no rule covers. You get a suggestion.</span></div>
        <div className="st"><span className="sc always"><Ph name="check-circle" size={13} />you pressed Always allow here</span><span>You click Always allow here. The click becomes a rule.</span></div>
      </div>
      <div className="legend rules">
        <span><Ph name="check-circle" size={14} />Rules reach agents agentglass started</span>
        <span><Ph name="check-circle" size={14} />and your own sessions <NewBadge /></span>
        <span style={{ flex: 1 }} />
        <span>Stricter changes apply at once. Looser ones wait for your click.</span>
      </div>
      {error && <div className="err-line" role="alert" style={{ marginBottom: 10 }}>{error}</div>}
      <Cards roots={roots} views={views} all={all} who={who} gates={gates} now={now} reload={load} />
    </section>
  );
}

function Cards({ roots, views, all, single, who, gates, now, reload }: {
  roots: string[]; views: Record<string, AgentRulesView>; all: boolean; single?: boolean;
  who: Props["who"]; gates: readonly HeldCall[]; now: number; reload: () => Promise<void>;
}) {
  const shown = roots.filter((r) => views[r]);
  return (
    <div className="pcards" style={single ? { gridTemplateColumns: "minmax(0, 1fr)" } : undefined}>
      {shown.map((r, i) => (
        <ProjectCard key={r} root={r} view={views[r]!} tag={all ? null : i === 0 ? "this project" : "another project"}
          who={who} gates={gates} now={now} reload={reload} />
      ))}
    </div>
  );
}

const SETTINGS: { v: RuleSetting; word: string; tone: "allow" | "ask" | "deny" }[] = [
  { v: "allow", word: "Allow", tone: "allow" }, { v: "ask", word: "Ask me", tone: "ask" }, { v: "never", word: "Never", tone: "deny" },
];

function Tri({ value, label, busy, onPick }: { value: RuleSetting | null; label: string; busy: boolean; onPick: (s: RuleSetting) => void }) {
  return (
    <div className="tri" role="group" aria-label={label}>
      {SETTINGS.map((o) => (
        <button key={o.v} type="button" className={value === o.v ? `on ${o.tone}` : ""} aria-pressed={value === o.v} disabled={busy} onClick={() => value !== o.v && onPick(o.v)}>{o.word}</button>
      ))}
    </div>
  );
}

function ProjectCard({ root, view, tag, who, gates, now, reload }: {
  root: string; view: AgentRulesView; tag: "this project" | "another project" | null;
  who: Props["who"]; gates: readonly HeldCall[]; now: number; reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [older, setOlder] = useState(false);
  const label = projectLabel(root);
  const totals = ruleTotals(view);
  const bars = growthBars(view.weekly, view.base.length, view.learned.length);
  /* Only the calls held in this project can be waiting on one of its suggestions. */
  const held = gates.filter((g) => { const w = who(g.session_id)?.worktree; return !!w && isUnder(w, root); });
  const nameOf = (session: string) => who(session)?.name;
  const { shown, older: rest } = splitLearned(view.learned, now);
  const listed = older ? [...shown, ...rest] : shown;

  const run = async (id: string, fn: () => Promise<{ ok: boolean; error?: string; waitsForPerson?: boolean }>) => {
    setBusy(id); setErr("");
    try {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "that did not go through");
    } catch { setErr("that did not go through"); }
    setBusy("");
    await reload();
  };
  const write = (rule: AgentRule, setting: RuleSetting) => run(rule.id, () => api.agentRuleSet(rowRequest(rule, setting)));
  const answer = (rule: AgentRule, a: { setting: RuleSetting } | { dismiss: true }) => run(rule.id, () => api.agentRuleAnswer(rule.id, a));
  const setMode = (mode: LaunchMode) => run(MODE_ACTION, () => api.agentRuleSet({ root: "*", action: MODE_ACTION, match: "", setting: mode === "default" ? "ask" : "allow", mode }));

  const row = (rule: AgentRule, opts: { fresh?: boolean; base?: boolean }) => {
    const chip = sourceChip(rule, opts.base);
    const mode = rule.action === MODE_ACTION;
    return (
      <div className={`lr${opts.fresh ? " fresh" : ""}`} key={rule.id}>
        <span className="ri"><Ph name={ruleIcon(rule)} size={15} /></span>
        <div>
          <div className="l1">
            <b>{ruleTitle(rule)}</b><code>{ruleCode(rule)}</code>
            {opts.fresh && <span className="fresh-t">learned this week</span>}
          </div>
          <div className="l2"><span className={`sc ${chip.kind === "plain" ? "" : chip.kind}`}><Ph name={chip.icon} size={13} />{chip.label}</span><span>{ruleWhen(rule, now, opts.base)}</span></div>
        </div>
        {mode
          ? (
            <div className="tri" role="group" aria-label="Permission mode">
              {MODE_CHOICES.map((c) => (
                <button key={c.mode} type="button" className={rule.mode === c.mode ? `on ${c.mode === "default" ? "ask" : "allow"}` : ""} aria-pressed={rule.mode === c.mode}
                  disabled={busy === MODE_ACTION} onClick={() => rule.mode !== c.mode && void setMode(c.mode)}>{c.word}</button>
              ))}
            </div>
          )
          : <Tri value={rule.setting} label={`${ruleTitle(rule)}: what an agent may do`} busy={busy === rule.id} onPick={(s) => void write(rule, s)} />}
      </div>
    );
  };

  return (
    <div className={`pcard${tag === "another project" ? " other" : ""}`} data-agent-rules-project={root}>
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
      {listed.map((l) => row(l.rule, { fresh: l.fresh }))}
      {rest.length > 0 && (
        <div className="older">
          <Ph name="eye-slash" size={15} /><b>{rest.length}</b> older learned rules<span style={{ flex: 1 }} />
          <button type="button" className="btn sm" aria-expanded={older} onClick={() => setOlder((v) => !v)}>{older ? "Hide" : "Show"}</button>
        </div>
      )}

      <div className="grp"><Ph name="circle-dashed" size={14} />Base, the same everywhere<span className="sp" /><span className="m">tiny on purpose</span></div>
      {baseOrder(view.base).map((rule) => row(rule, { base: true }))}
      {err && <div className="err-line" role="alert" style={{ padding: "8px 18px" }}>{err}</div>}
    </div>
  );
}
