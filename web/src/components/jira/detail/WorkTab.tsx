/*
 * The Work tab, the mockup's order: the hierarchy first (the sub-tasks with their add row, then the links), then who is working on the card and what was planned for it (the sessions and the flight plans the app already keeps),
 * then the card's files, which used to have a tab of their own. Nothing is read here; the Card tab's lifecycle reads it once.
 */
import { useState, type ReactNode } from "react";
import { usd } from "../../../lib/cardLifecycle.ts";
import { openFlightPlan } from "../../../lib/flightPlanNav.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { fmtAgo } from "../../../lib/format.ts";
import { Button } from "../../workspace/Chrome.tsx";
import { JiraSection } from "../JiraSections.tsx";
import { openLive } from "./cardWorkActions.ts";
import type { CardWork } from "./useCardLifecycle.ts";
import { StateCollapse } from "../../tasks/BoardState.tsx";

export function WorkTab({ work, hierarchy, files }: { work: CardWork; hierarchy?: ReactNode; files: ReactNode }) {
  const { sessions, plans } = work;
  /* Which session's id was just copied: its button says so for a moment, as the header's copy buttons do. */
  const [copied, setCopied] = useState<string | null>(null);
  const copyId = (id: string) => void navigator.clipboard?.writeText(id).then(() => { setCopied(id); setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200); }, () => undefined);
  /* What the card has cost in agents, every session that ever named it: the one number a session row cannot give. */
  const spent = sessions.reduce((n, s) => n + s.cost, 0);
  const waiting = sessions.find((s) => s.status === "waiting");
  /* Stalled or errored wants a look as well; it gets the banner only when nobody is waiting, so there is one at a time. */
  const stuck = waiting ? undefined : sessions.find((s) => s.live && (s.status === "stalled" || s.status === "errored"));
  return (
    <>
      {hierarchy}
      {sessions.length > 0 && <JiraSection id="sessions" title="Workers" count={sessions.length || undefined}
        aside={sessions.length > 1 ? <span className="tabular-nums" data-tip={tipAttr(`What the ${sessions.length} sessions on this card have cost, together`)}>{usd(spent)} in all</span> : undefined}>
        {/* A session stopped on a person leads the tab: the row below says it too, in grey, among the others. */}
        {waiting && (
          <div className="agx-jd-wait" role="status">
            <span className="agx-jd-dot" aria-hidden />
            <span className="min-w-0 flex-1 truncate"><b>{waiting.title}</b> is waiting on you{waiting.doing ? ` · ${waiting.doing}` : ""}</span>
            <Button size="compact" className="shrink-0" data-tip={tipAttr("Bring its tab forward, where the answer is typed (t)")} onClick={() => openLive(plans[0] ?? null, waiting)}>Open its tab</Button>
          </div>
        )}
        {stuck && (
          <div className="agx-jd-wait" data-stuck="" role="status">
            <span className="agx-jd-dot" aria-hidden />
            <span className="min-w-0 flex-1 truncate"><b>{stuck.title}</b> has {stuck.status}{stuck.doing ? ` · ${stuck.doing}` : ""}</span>
            <Button size="compact" className="shrink-0" data-tip={tipAttr("Bring its tab forward to see what stopped it (t)")} onClick={() => openLive(plans[0] ?? null, stuck)}>Open its tab</Button>
          </div>
        )}
        <div className="agx-dk-stack">
          {sessions.map((s) => (
            <div key={s.sessionId} className="agx-dk-mini"
              data-tip={tipAttr({ name: s.title, detail: s.live ? s.status : `ended ${fmtAgo(s.lastSeen)} ago`, text: `${s.doing ? `${s.live ? "Now" : "Last"}: ${s.doing}. ` : ""}${s.model ?? "model unknown"} · ${s.tools ?? 0} tool calls${s.errors ? ` · ${s.errors} errors` : ""} · ${usd(s.cost)}` })}>
              {/* The dot is the session's state, as the header chip draws it: green working, yellow waiting, red stalled or errored. */}
              <span className="agx-jd-dot" data-live={s.live && s.status === "working" ? "" : undefined} data-needs={s.live && s.status === "waiting" ? "" : undefined}
                data-stuck={s.live && (s.status === "stalled" || s.status === "errored") ? "" : undefined} aria-hidden />
              <span className="agx-dk-t flex-1 min-w-0 truncate">{s.title}</span>
              <span className="agx-dk-k shrink-0">{s.live ? s.status : `ended ${fmtAgo(s.lastSeen)} ago`}</span>
              <span className="agx-dk-k tabular-nums shrink-0">{usd(s.cost)}</span>
              {s.live
                ? <Button size="compact" className="shrink-0" data-tip={tipAttr("Bring its tab forward (t)")} onClick={() => openLive(plans[0] ?? null, s)}>Open</Button>
                /* An ended session has no tab to open; its id is what picks it up again (`--resume` in the agent's CLI). */
                : <Button size="compact" className="shrink-0" data-tip={tipAttr({ name: "Copy session id", text: s.sessionId })}
                    onClick={() => copyId(s.sessionId)}>{copied === s.sessionId ? "Copied" : "Copy id"}</Button>}
            </div>
          ))}
        </div>
      </JiraSection>}
      <JiraSection id="plans" title="Flight plans" count={plans.length || undefined}>
        {!plans.length && <StateCollapse />}
        <div className="agx-dk-stack">
          {plans.map((p) => (
            <div key={p.id} className="agx-dk-mini">
              <span className="agx-dk-t flex-1 min-w-0 truncate">{p.title}</span>
              <span className="agx-dk-k shrink-0">{p.state}</span>
              <span className="agx-dk-k tabular-nums shrink-0">{p.reviewRounds} {p.reviewRounds === 1 ? "round" : "rounds"}</span>
              <Button size="compact" className="shrink-0" onClick={() => openFlightPlan({ plan: p.id })}>Open</Button>
            </div>
          ))}
        </div>
      </JiraSection>
      {files}
    </>
  );
}
