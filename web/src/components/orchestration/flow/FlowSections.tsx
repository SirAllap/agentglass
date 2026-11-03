import type { ReactNode } from "react";
import { Disclosure, StatusBadge } from "../../SettingsKit.tsx";
import { Button } from "../../workspace/Chrome.tsx";
import { Toggle } from "../../SettingRow.tsx";
import { LockIcon, TagIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { FlowIcon } from "./flowIcons.tsx";
import { PAGE_BTN_SM } from "../OrchKit.tsx";
import { DENIED_COMMANDS, NEVER_LIFTABLE } from "../../../../../shared/workerRoles.ts";
import type { Envelope, Policy } from "../../../../../shared/orchestration.ts";
import { LIMIT_RANGE, OLD_WORDS, SAFETY, safetyIsDefault } from "../orchestrationCopy.ts";
import { AgentTrustRow } from "../AgentTrustRow.tsx";
import { DenyBox, EnvelopeRows, GateRow, Note } from "../SafetyParts.tsx";
import { CountStepper } from "../SafetyParts.tsx";

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
const LEVELS: { id: string; title: string; says: string; ico: string; env: Pick<Envelope, "write" | "commit" | "network" | "docker"> }[] = [
  { id: "cautious", title: "Cautious", says: "Workers look, never touch.", ico: "lock", env: { write: "none", commit: false, network: false, docker: false } },
  { id: "balanced", title: "Balanced", says: "Workers build in their own copy.", ico: "shield", env: { write: "worktree", commit: true, network: false, docker: false } },
  { id: "open", title: "Open", says: "Workers may reach the network.", ico: "gauge", env: { write: "worktree", commit: true, network: true, docker: false } },
];

/** One level's three lines, in order, and whether that line is on. */
const levelLines = (e: Pick<Envelope, "write" | "commit" | "network">): [string, boolean][] =>
  [["Write files", e.write === "worktree"], ["Commit", e.commit], ["Network", e.network]];

/** What is on now, in one sentence, when the stored envelope is none of the three. */
export function nowSentence(e: Envelope): string {
  const parts = [
    e.write === "worktree" ? "workers write in their own copy" : "workers cannot write",
    e.commit ? "may commit locally" : "cannot commit locally",
    e.network ? "may reach the network" : "cannot reach the network",
    ...(e.docker ? ["may run docker"] : []),
  ];
  return `Now: ${parts.join(", ")}. No level matches.`;
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
  { title: "Git", note: "No block, rule or preset can turn these on, except a local commit when the most allowed is on. A role may be granted one in the worker editor, but never a push.", keep: (c) => c.startsWith("git ") },
  { title: "Network and other machines", note: "gh, ssh and scp never lift. curl, wget and docker may, and only where the most allowed is on; a role may also be granted docker or aws in the worker editor.", keep: (c) => ["gh", "curl", "wget", "ssh", "scp", "docker", "aws"].includes(c) },
  { title: "This machine", note: "Never granted to a worker, whatever its role.", keep: (c) => ["sudo", "rm"].includes(c) },
];

export function SafetySection(p: {
  policy: Policy; env: EnvDraft; onEnv: (e: EnvDraft) => void;
  onLimits: (k: keyof Policy["limits"], to: number) => void;
  locked: boolean; note?: string;
  rounds: number; root: string;
  /** The tab that lists, in full, what is always refused. */
  onSeeRefused: () => void;
}) {
  const { policy, env, locked } = p;
  const limits = Object.keys(LIMIT_RANGE) as (keyof Policy["limits"])[];
  const nowLevel = LEVELS.find((l) => l.env.write === env.workerDefault.write && l.env.commit === env.workerDefault.commit
    && l.env.network === env.workerDefault.network && l.env.docker === env.workerDefault.docker)?.id ?? null;
  // One switch, two fields: a default wider than the most allowed is a policy the server refuses.
  const setDocker = (on: boolean) => {
    if (locked) return;
    p.onEnv({ ...env, workerDefault: { ...env.workerDefault, docker: on }, ceiling: { ...env.ceiling, docker: on } });
  };
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

      <div className="agx-flow-grid2">
        <PageCard ico="gauge" title="Limits" sub="Counted per task, not per day. How much the main agent may start at once.">
          <div className="agx-flow-rows">
            {limits.map((k) => (
              <div key={k} className="agx-flow-row" data-limit={k}>
                <span className="d">{LIMIT_RANGE[k].label}<small>{LIMIT_RANGE[k].short}</small></span>
                <CountStepper id={k} value={policy.limits[k]} min={LIMIT_RANGE[k].min} max={LIMIT_RANGE[k].max} label={LIMIT_RANGE[k].label}
                  onChange={(v) => p.onLimits(k, v)} />
              </div>
            ))}
          </div>
        </PageCard>

        <PageCard ico="alert" title="When a limit is reached" sub="The block stops and says so. Nothing carries on in the dark.">
          <div className="agx-flow-when3">
            <div className="agx-flow-whenb"><b>Minutes per turn</b><span>The turn stops, keeps its copy, and comes back to you with what it had done.</span></div>
            <div className="agx-flow-whenb"><b>Review rounds</b><span>Round {p.rounds + 1} does not start. You choose which findings to keep and which to drop.</span></div>
            <div className="agx-flow-whenb"><b>Workers at once</b><span>The next worker waits. Nothing is lost; the task carries on when one finishes.</span></div>
          </div>
        </PageCard>
      </div>

      <div className="agx-flow-grid2">
        <PageCard ico="shield" title={SAFETY.workers.title} sub={SAFETY.workers.note}>
          <div data-default-envelope className="agx-flow-cardrows">
            <EnvelopeRows prefix="Default: " env={env.workerDefault} locked={locked} noDeny
              onChange={(workerDefault) => { if (!locked) p.onEnv({ ...env, workerDefault }); }} />
          </div>
        </PageCard>

        <PageCard ico="lock" title={SAFETY.most.title} sub={SAFETY.most.note}
          right={safetyIsDefault(policy) ? <StatusBadge tone="off">defaults</StatusBadge> : <StatusBadge tone="ok">changed</StatusBadge>}>
          <div data-safety className="agx-flow-cardrows">
            <EnvelopeRows prefix="At most: " env={env.ceiling} locked={locked} onChange={(ceiling) => {
              if (!locked) p.onEnv({ ...env, ceiling });
            }} />
          </div>
        </PageCard>
      </div>

      <div className="agx-flow-grid2">
        <PageCard ico="users" title="Agents and the settings themselves" sub="The trust switch and the Gate.">
          <div className="agx-flow-cardrows">
            <AgentTrustRow root={p.root} />
            <GateRow />
          </div>
        </PageCard>

        <PageCard ico="lock" title={SAFETY.hands.title} sub={SAFETY.hands.note}>
          <div className="agx-flow-row">
            <span className="d"><b>A block can be given fewer tools</b><small>Never more than the limits above</small></span>
            <Button style={PAGE_BTN_SM} onClick={p.onSeeRefused}>See what is always refused</Button>
          </div>
        </PageCard>

        <PageCard ico="terminal" title="Extra shell commands" sub={SAFETY.extra.note} wide>
          <div className="agx-flow-cardrows">
            <Toggle label="Docker for workers" hint="Lets a worker you grant it to run docker. Needs your Approve click." disabled={locked}
              on={env.workerDefault.docker} onClick={() => setDocker(!env.workerDefault.docker)} />
            <div className="agx-flow-row" data-never-allowed>
              <span className="d"><b>Never allowed</b><small>Locked for every worker, in every project. There is no switch for these.</small></span>
              <span className="agx-flow-locked">
                {NEVER_LIFTABLE.map((c) => <code key={c} className="agx-flow-cmd">{c}</code>)}
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
