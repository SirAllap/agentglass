import type { ReactNode } from "react";
import { Disclosure, StatusBadge } from "../../SettingsKit.tsx";
import { Button } from "../../workspace/Chrome.tsx";
import { SettingRow } from "../../SettingRow.tsx";
import { LockIcon, TagIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { FlowIcon } from "./flowIcons.tsx";
import { PAGE_BTN_SM } from "../OrchKit.tsx";
import { DENIED_COMMANDS, FIXED_COMMANDS, SWITCHABLE_COMMANDS } from "../../../../../shared/workerRoles.ts";
import type { Envelope, Policy } from "../../../../../shared/orchestration.ts";
import { OLD_WORDS, SAFETY, safetyIsDefault } from "../orchestrationCopy.ts";
import { AgentTrustRow } from "../AgentTrustRow.tsx";
import { FlowAgentEditRow } from "../FlowAgentEditRow.tsx";
import { FlowDelegationRow } from "../FlowDelegationRow.tsx";
import { DenyBox, DenyList, EnvelopeTable, Note } from "../SafetyParts.tsx";

/**
 * The two sections under the page: Safety and limits, and Always refused. The
 * save bar is the page's, drawn once and only while something is unsaved.
 *
 * Its ceiling: docker is one switch over two fields (the default and the most
 * allowed), because a default wider than the most allowed is a policy the
 * server refuses.
 */

export interface EnvDraft { ceiling: Envelope; workerDefault: Envelope }

/** The three levels, each the worker default's whole envelope; docker is off in all three and has its own switch. */
export const LEVELS: { id: string; title: string; says: string; ico: string; env: Pick<Envelope, "write" | "commit" | "network" | "docker"> }[] = [
  { id: "cautious", title: "Cautious", says: "Workers look, never touch.", ico: "lock", env: { write: "none", commit: false, network: false, docker: false } },
  { id: "balanced", title: "Balanced", says: "Workers build in their own copy.", ico: "shield", env: { write: "worktree", commit: true, network: false, docker: false } },
  { id: "open", title: "Open", says: "Workers may reach the network.", ico: "gauge", env: { write: "worktree", commit: true, network: true, docker: false } },
];

/** One level's three lines, in order, and whether that line is on. */
const levelLines = (e: Pick<Envelope, "write" | "commit" | "network">): [string, boolean][] =>
  [["Write files", e.write === "worktree"], ["Commit", e.commit], ["Network", e.network]];

/**
 * What is on now when the stored envelope is none of the three levels: the
 * level that differs in the fewest of write, commit and network (a tie goes to
 * the more cautious, which LEVELS lists first), then the fields that differ,
 * e.g. "Custom: Balanced, with network on". Docker is left out because it has
 * its own switch.
 */
export function nowSentence(e: Envelope): string {
  const fields: [string, (x: Pick<Envelope, "write" | "commit" | "network">) => boolean][] = [
    ["write", (x) => x.write === "worktree"], ["commit", (x) => x.commit], ["network", (x) => x.network],
  ];
  const differs = (l: (typeof LEVELS)[number]) => fields.filter(([, on]) => on(l.env) !== on(e));
  let best = LEVELS[0]!;
  for (const l of LEVELS) if (differs(l).length < differs(best).length) best = l;
  const diff = differs(best).map(([name, on]) => `${name} ${on(e) ? "on" : "off"}`);
  return `Custom: ${best.title}${diff.length ? `, with ${diff.join(", ")}` : ""}`;
}

/** The mockup's card: its h3 with the glyph, one line under it, then the rows.
 *  Not the kit's `SettingsCard`, whose head is a title row with actions and a
 *  fold; this one is the approved page's plain card. */
function PageCard({ ico, title, sub, right, children, wide }: { ico?: string; title: string; sub: string; right?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <section className="agx-flow-card" style={wide ? { gridColumn: "1 / -1" } : undefined}>
      <h3>{ico && <FlowIcon name={ico} size={ICON.sm} />}{title}{right && <span className="agx-flow-cardmark">{right}</span>}</h3>
      <p className="sub">{sub}</p>
      {children}
    </section>
  );
}

/** Where the always-refused prefixes are grouped; each prefix is the real one the roles are started with. */
const GROUPS: { title: string; note: string; keep: (c: string) => boolean }[] = [
  { title: "Git", note: "Four worktree commands no block, rule or preset can turn on. A role's extra-commands box lifts only git commit, and only when the most allowed has commit on.", keep: (c) => c.startsWith("git ") },
  { title: "Network", note: "Nothing here is fixed. curl, wget and ssh follow the Network switch and their own switches; a role's box lifts only curl or wget, and only where the most allowed has network on.", keep: (c) => ["gh", "curl", "wget", "ssh", "scp", "docker", "aws"].includes(c) },
  { title: "This machine", note: "Never granted to a worker, whatever its role. rm and signals are not here: they are open by default and have their own switches.", keep: (c) => c === "sudo" },
];

export function SafetySection(p: {
  policy: Policy; env: EnvDraft; onEnv: (e: EnvDraft) => void;
  locked: boolean; note?: string;
  root: string;
  /** The tab that lists, in full, what is always refused. */
  onSeeRefused: () => void;
}) {
  const { policy, env, locked } = p;
  const nowLevel = LEVELS.find((l) => l.env.write === env.workerDefault.write && l.env.commit === env.workerDefault.commit
    && l.env.network === env.workerDefault.network && l.env.docker === env.workerDefault.docker)?.id ?? null;
  return (
    <div className="agx-flow-pane" data-pane="safety">
      <div className="agx-flow-grid3" role="group" aria-label={SAFETY.workers.title}>
        {LEVELS.map((level) => {
          const on = nowLevel === level.id;
          return (
            <button key={level.id} type="button" className="agx-flow-level" data-level={level.id} aria-pressed={on} disabled={locked}
              onClick={() => { if (!locked) p.onEnv({ ...env, workerDefault: { ...env.workerDefault, ...level.env } }); }}>
              <h4>
                <span aria-hidden className="agx-flow-level-ico"><FlowIcon name={level.ico} size={ICON.sm} /></span>
                {level.title}
                {on && <span className="agx-flow-chip" data-tone="acc">Now</span>}
              </h4>
              <span className="agx-flow-level-says">{level.says}</span>
              <ul>
                {levelLines(level.env).map(([what, lit]) => (
                  <li key={what} data-line={what.toLowerCase()} data-on={lit ? "" : undefined}>
                    <span aria-hidden className="agx-flow-level-mark"><FlowIcon name={lit ? "check" : "x"} size={ICON.xs} /></span>
                    {what}
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>
      {nowLevel === null && <p className="agx-flow-levels-now">{nowSentence(env.workerDefault)}</p>}

      <PageCard ico="shield" title="What a worker may do" sub={`${SAFETY.workers.note} ${SAFETY.most.note}`} wide
        right={safetyIsDefault(policy) ? <StatusBadge tone="off">defaults</StatusBadge> : <StatusBadge tone="ok">changed</StatusBadge>}>
        <div data-default-envelope data-safety className="agx-flow-cardrows">
          <EnvelopeTable workerDefault={env.workerDefault} ceiling={env.ceiling} locked={locked} onChange={(n) => { if (!locked) p.onEnv({ ...env, ...n }); }} />
          <SettingRow label="Most allowed: also refuse" hint={SAFETY.deny}
            below={<DenyList id="Most-allowed-deny" deny={env.ceiling.deny} disabled={locked} onChange={(deny) => { if (!locked) p.onEnv({ ...env, ceiling: { ...env.ceiling, deny } }); }} />} />
        </div>
      </PageCard>

      <div className="agx-flow-grid2">
        <PageCard ico="lock" title={SAFETY.hands.title} sub={SAFETY.hands.note}>
          <div className="agx-flow-row">
            <span className="d"><b>A block can be given fewer tools</b><small>Never more than the limits above</small></span>
            <Button style={PAGE_BTN_SM} onClick={p.onSeeRefused}>See what is always refused</Button>
          </div>
        </PageCard>

        <PageCard ico="terminal" title="Extra shell commands" sub={SAFETY.extra.note} wide>
          <div className="agx-flow-cardrows">
            <div className="agx-flow-row" data-never-allowed>
              <span className="d"><b>Fixed: never allowed</b><small>No switch and no role can open these, in any project.</small></span>
              <span className="agx-flow-locked">
                {FIXED_COMMANDS.map((c) => <code key={c} className="agx-flow-cmd">{c}</code>)}
              </span>
            </div>
            <div className="agx-flow-row" data-switch-only>
              <span className="d"><b>Open until you close them</b><small>Open by default. Each has its own Open or Closed switch per project, below; closing one narrows every worker.</small></span>
              <span className="agx-flow-locked">
                {SWITCHABLE_COMMANDS.map((c) => <code key={c} className="agx-flow-cmd">{c}</code>)}
              </span>
            </div>
          </div>
        </PageCard>
      </div>

      <p className="agx-flow-x">{OLD_WORDS}</p>
      <Note text={p.note} />
    </div>
  );
}

/** The prefixes no worker is started with, grouped, plus the extra ones this scope adds. */
export function RefusedSection(p: {
  policy: Policy; locked: boolean; note?: string;
  /** "All projects", or the project's name. */
  scopeWord: string;
  onDeny: (deny: string[]) => void;
}) {
  const extra = p.policy.workerDefault.deny;
  return (
    <div className="agx-flow-pane" data-pane="refused">
      <div className="agx-flow-fixed" data-fixed>
        <span aria-hidden className="agx-flow-fixedico"><LockIcon size={ICON.sm} /></span>
        <div className="agx-flow-fixedtext">
          <b>Fixed for everyone</b>
          <small>The same in every project. No setting, rule or agent can loosen these.</small>
        </div>
        <span className="agx-flow-chip" data-tone="plain"><LockIcon size={ICON.xs} />not editable</span>
      </div>

      <div className="agx-flow-grid3">
        {GROUPS.map((g) => (
          <PageCard key={g.title} title={g.title} sub={g.note}>
            <div className="agx-flow-refused">
              {DENIED_COMMANDS.filter(g.keep).map((c) => <code key={c} className="agx-flow-cmd">{c}</code>)}
            </div>
          </PageCard>
        ))}
      </div>

      <div className="agx-flow-fixed" data-only>
        <span aria-hidden className="agx-flow-fixedico" data-tone="acc"><TagIcon size={ICON.sm} /></span>
        <div className="agx-flow-fixedtext">
          <b>Only for {p.scopeWord}</b>
          <small>Added on top of the fixed list, for this project alone. You can add and remove lines.</small>
        </div>
        <span className="agx-flow-chip" data-tone="acc">{p.scopeWord}</span>
      </div>

      <PageCard title="Also refused here" sub={`One command per line. Workers of ${p.scopeWord} cannot run them; other projects are not touched.`}>
        <DenyBox deny={extra} disabled={p.locked} onChange={p.onDeny} />
      </PageCard>

      <p className="agx-flow-x">
        <b>{SAFETY.always.hint}</b>{" "}
        <Disclosure summary={SAFETY.always.more}><p className="agx-flow-p m-0">{SAFETY.always.body}</p></Disclosure>
      </p>
      <p className="agx-flow-x">A refusal is logged with the block's name and the exact action. It is never retried on its own, and no preset can switch one of these on.</p>
      <Note text={p.note} />
    </div>
  );
}


/** Main agent: the trust switch and the two flow switches, one card. Gate is on Changes outside. */
export function MainTrustCard({ root }: { root: string }) {
  return (
    <PageCard ico="users" title="Agents and the flow" sub="Whether your agents may change settings without asking, and what the orchestrator may edit.">
      <div className="agx-flow-cardrows">
        <AgentTrustRow root={root} />
        <FlowAgentEditRow root={root} />
        <FlowDelegationRow root={root} />
      </div>
    </PageCard>
  );
}
