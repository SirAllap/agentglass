/*
 * The Conditions drawer of the Flow editor: the rules that change which engine
 * a block uses, one plain sentence each. It takes the block panel's slot (the
 * editor closes the other when one opens), so nothing on the canvas moves, and
 * it is the mockup's 430px sheet: a head, one scrolling body, a footer that
 * says which scope it writes.
 *
 * The list order is the priority: for one block, the first rule in the list that
 * is on and names it wins (`resolve` does exactly that), so a rule that shares a
 * block with another says where it stands and moves with ↑ ↓, which changes the
 * stored order. Rules the blocks made themselves (`fallback-<role>`) are listed
 * read-only with a pointer to the block. A project that has no setting of its
 * own shows the all-projects rules read-only with one button that gives it its
 * own copy.
 *
 * Its ceiling, stated: the order is one list for every block; "this rule wins on
 * Builder but loses on Planner" is two rules, not a per-block order.
 */
import { SideGrip } from "./SideGrip.tsx";
import { Fragment, useState, type ReactNode } from "react";
import type { Flow } from "../../../../../shared/flow.ts";
import { planWord, ROLE_IDS, usageProvider, type Chain, type PolicyRule, type Trigger } from "../../../../../shared/orchestration.ts";
import { shortChain } from "./flowScreenCopy.ts";
import { planRule } from "./flowCopy.ts";
import { roleLabel } from "../../../lib/roleLabel.ts";
import { ruleHolds, scopeWords, usageLeft, withRuleEnabled } from "../orchestrationCopy.ts";
import type { Around } from "./AroundFlow.tsx";
import { Switch } from "./Switch.tsx";
import { ruleTouches, withRuleMoved } from "./canvasRules.ts";
import { fallbackRuleId } from "./PolicyRoleControls.tsx";
import { FlowIcon } from "./flowIcons.tsx";

export const EMPTY_CONDITIONS = "No conditions. Blocks use their usual engine.";

/** The role a `fallback-<role>` rule was made for, or null for a rule a person wrote. */
export const fallbackRole = (id: string) => ROLE_IDS.find((r) => fallbackRuleId(r) === id) ?? null;

/** What lifts a rule again by itself, in the mockup's short token. */
export function ruleBack(r: PolicyRule): string {
  const usage = r.when.find((t) => t.kind === "usage");
  if (usage?.kind === "usage") return `below ${100 - usage.remainingAtMost}% used`;
  const hours = r.when.find((t) => t.kind === "hours");
  if (hours?.kind === "hours") return `at ${hours.to}`;
  if (r.when.some((t) => t.kind === "limit")) return "when the window resets";
  if (r.when.some((t) => t.kind === "budget")) return "when it resets";
  return "nothing: it holds until it is turned off";
}

/** The plan an engine's blocks move to, in the mockup's words: Claude, OpenCode Go, Codex. */
const planName = (engine: string): string => planWord(usageProvider(engine));

/**
 * What a rule moves, in the mockup's short token: one engine for every block it
 * names, or each block to its own chain. The per-block detail is the chips below.
 */
export function ruleThen(r: PolicyRule): string {
  const engines = new Set<string>();
  if (r.orchestrator?.[0]) engines.add(planName(r.orchestrator[0].engine));
  let blocks = 0;
  for (const id of ROLE_IDS) {
    const chain = r.workers?.[id];
    if (!chain?.[0]) continue;
    blocks += 1;
    engines.add(planName(chain[0].engine));
  }
  if (engines.size === 0) return "Nothing changes";
  if (engines.size > 1) return "Each block to its own chain";
  const only = [...engines][0]!;
  if (blocks === 0) return `The main agent on ${only}`;
  return blocks === 1 ? `The block on ${only}` : `Workers on ${only}`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function hoursDays(days: number[]): string {
  if (days.length === 7) return "";
  const weekdays = days.length === 5 && days.every((d, i) => d === i + 1);
  return `, ${weekdays ? "Mon–Fri" : days.map((d) => DAY_NAMES[d] ?? "?").join(", ")}`;
}
/**
 * One trigger as the mockup's short clause, with the days said only when they
 * narrow the rule, so the card never claims more of the week than the rule holds.
 */
const whenToken = (t: Trigger): string =>
  t.kind === "usage" ? `${planWord(t.provider)} plan used ≥ ${100 - t.remainingAtMost}%`
    : t.kind === "hours" ? `Between ${t.from} and ${t.to}${hoursDays(t.days)}`
      : t.kind === "limit" ? `${planWord(t.provider)} plan ran out`
        : t.kind === "budget" ? "Budget used up"
          : "Always";

export function ConditionsPanel(p: {
  a: Around; flow: Flow; onClose: () => void;
  onHover: (id: string | null) => void;
  onNew: () => void; onEdit: (id: string) => void;
  onPickBlock: (role: string) => void;
  /** The rule editor, when a rule is open: it takes the list's place in the same panel. */
  editor?: { title: string; body: ReactNode; ask?: { onKeep: () => void; onDiscard: () => void } };
}) {
  const { a, flow } = p;
  const policy = a.policy;
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scope = a.own ? a.root : "";
  const stateScope = a.own && a.root ? a.root : "global";
  const holds = ruleHolds(a.states, stateScope);
  const inherited = !!a.root && !a.own;
  const project = scopeWords(a.root);
  const run = async (next: NonNullable<typeof policy>) => { setBusy(true); const e = await a.saveRule(next); setBusy(false); setNote(e); };
  const plan = policy ? planRule(policy) : undefined;
  const planWhen = plan?.when.find((t): t is Extract<typeof t, { kind: "usage" }> => t.kind === "usage");
  const movedRole = plan ? ROLE_IDS.find((r) => plan.workers?.[r]) ?? null : null;
  const planChain = plan ? (movedRole ? plan.workers?.[movedRole] : plan.orchestrator) : undefined;
  const planLeft = planWhen ? usageLeft(a.states, stateScope)[planWhen.provider] ?? null : null;
  /** The block a rule names first, when it is on the path: what "Open the block" presses. */
  const firstBlock = (r: PolicyRule): string | null => {
    const fb = fallbackRole(r.id);
    if (fb) return fb;
    for (const id of ROLE_IDS) {
      if (!r.workers?.[id]) continue;
      const role = flow.roster.find((x) => x.policyRole === id && flow.path.includes(x.id));
      if (role) return id;
    }
    return null;
  };
  return (
    <aside className="fe-side fe-condside" aria-label="Conditions" data-conditions-panel data-mode={p.editor ? "edit" : "list"}>
      <SideGrip />
      <div className="fe-drawerhead">
        <span className="fe-tile" aria-hidden="true"><FlowIcon name="gauge" size={18} /></span>
        <div><b>{p.editor ? p.editor.title : "Conditions"}</b><small>{p.editor ? "Press blocks on the canvas to set what the rule changes" : "Rules that move a block to another engine"}</small></div>
        <span className="fe-sp" />
        <button className="fe-btn" data-size="sm" data-tone="quiet" type="button" title="Close" aria-label="Close" onClick={p.onClose}><FlowIcon name="x" size={14} /></button>
      </div>
      <div className="fe-drawerbody">
        {p.editor?.ask && (
          <div className="fe-leave" role="alertdialog" aria-label="Unsaved changes" data-leave>
            <span>You have unsaved changes to this condition.</span>
            <span className="fe-leaveacts"><button type="button" className="fe-btn" data-size="sm" onClick={p.editor.ask.onKeep}>Keep editing</button><button type="button" className="fe-btn" data-size="sm" data-tone="danger" onClick={p.editor.ask.onDiscard}>Discard</button></span>
          </div>
        )}
        {p.editor ? p.editor.body : !policy ? <p className="fe-quiet" role={a.note ? "alert" : undefined}>{a.note || "Reading the policy…"}</p> : (
          <>
            {inherited && (
              <div className="fe-inherit" data-inherited>
                <span>From “All projects”: read only here.</span>
                <button type="button" className="fe-btn" data-size="sm" disabled={busy} onClick={() => void a.claim().then(setNote)}>Override for {project}</button>
              </div>
            )}
            {planWhen && (
              <div className="fe-plan" data-plan>
                <div className="fe-planhead"><small>{planWord(planWhen.provider)} plan used</small>{planLeft !== null && <small className="fe-plannum">now {100 - planLeft}%</small>}</div>
                <div className="fe-planbar" role="img" data-strip="meter" aria-label={planLeft === null ? "No reading yet" : `${100 - planLeft}% used; the rule switches at ${100 - planWhen.remainingAtMost}%`}>
                  {planLeft !== null && <i style={{ width: `${100 - planLeft}%` }} />}
                  <u style={{ left: `${100 - planWhen.remainingAtMost}%` }} />
                </div>
              </div>
            )}
            {policy.rules.length === 0 && <p className="fe-quiet" data-empty>{EMPTY_CONDITIONS}</p>}
            <ol className="fe-rules" role="list">
              {policy.rules.map((r, i) => {
                const fb = fallbackRole(r.id);
                const live = r.enabled && holds(r.id);
                const n = ruleTouches(r).length;
                const locked = inherited || fb !== null;
                const block = firstBlock(r);
                const roles = ROLE_IDS.filter((id) => r.workers?.[id]);
                return (
                  <li key={r.id} className="fe-rule" data-rule={r.id} data-on={live ? "" : undefined} data-locked={locked ? "" : undefined} data-off={r.enabled ? undefined : ""}
                    onMouseEnter={() => p.onHover(r.id)} onMouseLeave={() => p.onHover(null)} onFocus={() => p.onHover(r.id)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) p.onHover(null); }}>
                    <div className="fe-rulehead">
                      <span className="fe-ord" title="First match wins">{i + 1}</span>
                      <b>{r.name}</b>
                      <span className="fe-sp" />
                      {!locked && <button type="button" className="fe-btn" data-size="sm" data-tone="quiet" aria-label={`Move ${r.name} up`} title="Higher in the list wins" disabled={i === 0 || busy} onClick={() => void run(withRuleMoved(policy, r.id, -1))}>↑</button>}
                      {!locked && <button type="button" className="fe-btn" data-size="sm" data-tone="quiet" aria-label={`Move ${r.name} down`} title="Lower in the list loses" disabled={i === policy.rules.length - 1 || busy} onClick={() => void run(withRuleMoved(policy, r.id, 1))}>↓</button>}
                      <Switch on={r.enabled} label={`${r.name}: ${r.enabled ? "on" : "off"}`} disabled={locked || busy} onChange={(on) => void run(withRuleEnabled(policy, r.id, on))} />
                    </div>
                    {fb ? (
                      <p className="fe-rulesentence">Made by the block's own fallbacks. Edit it on the {roleLabel(fb, flow).name} block; it is listed here so nothing is hidden.</p>
                    ) : (
                      <div className="fe-sent">
                        <span className="fe-when">When</span>
                        {r.when.map((t, k) => (
                          <Fragment key={`w-${k}`}>{k > 0 && <span className="fe-when">and</span>}<span className="fe-tok">{whenToken(t)}</span></Fragment>
                        ))}
                        <span className="fe-when">run</span>
                        <span className="fe-tok">{ruleThen(r)}</span>
                        <span className="fe-when">· back</span>
                        <span className="fe-tok">{ruleBack(r)}</span>
                      </div>
                    )}
                    <div className="fe-rchips">
                      <span className="fe-chip">{n === 0 ? "touches no block" : `touches ${n} ${n === 1 ? "block" : "blocks"}`}</span>
                      {roles.map((id) => <span key={id} className="fe-chip">{roleLabel(id, flow).name}: own chain</span>)}
                      {Object.keys(r.workers ?? {}).length >= 3 && roles.map((id) => (
                        <span key={`c-${id}`} className="fe-chip fe-chipwide">{roleLabel(id, flow).name}: {shortChain(r.workers?.[id] as Chain)}</span>
                      ))}
                    </div>
                    <div className="fe-ract">
                      {!locked && <button type="button" className="fe-btn" data-size="sm" onClick={() => p.onEdit(r.id)}>Edit</button>}
                      {block && <button type="button" className="fe-btn" data-size="sm" data-tone="quiet" onClick={() => p.onPickBlock(block)}>Open the block</button>}
                    </div>
                  </li>
                );
              })}
            </ol>
            <button type="button" className="fe-btn" data-tone="primary" data-new-condition disabled={inherited || busy} onClick={p.onNew}><FlowIcon name="plus" size={12} />New condition</button>
            <section className="fe-fbcard" aria-label="Fallback" data-fallback>
              <h3>Fallback</h3>
              {!plan || !planChain?.length ? (
                <p className="fe-quiet">No usage rule is set. Add one to switch engines when a plan runs low.</p>
              ) : (
                <>
                  <p className="fe-quiet">When the plan runs low, switch engines.</p>
                  <div className="fe-fbrow">
                    <span>Switch at<small>of the {planWhen ? `${planWord(planWhen.provider)} plan` : "plan"}</small></span>
                    <b>{planWhen ? `${100 - planWhen.remainingAtMost}%` : "—"}</b>
                  </div>
                  <div className="fe-fbrow">
                    <span>Switch to</span>
                    <span className="fe-fbchip">{planName(planChain[0]!.engine)}</span>
                  </div>
                  <div className="fe-fbrow">
                    <span>Then go back<small>the rule lifts by itself above that</small></span>
                    <b>{plan.enabled ? "on its own" : "never"}</b>
                  </div>
                  <div className="fe-fbrow">
                    <span>On</span>
                    <Switch on={plan.enabled} label="Fallback rule" disabled={inherited || busy} onChange={(on) => void run(withRuleEnabled(policy, plan.id, on))} />
                  </div>
                </>
              )}
            </section>
            {note && <p className="fe-errline" role="alert">{note}</p>}
          </>
        )}
      </div>
      <div className="fe-drawerfoot">
        <span className="fe-chip">Scope: {scope ? project : "all projects"}</span>
        <span className="fe-sp" />
        <button className="fe-btn" type="button" onClick={p.onClose}>Close</button>
      </div>
    </aside>
  );
}
