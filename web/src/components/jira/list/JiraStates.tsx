/*
 * What the list area shows when there are no lanes to draw: the skeleton while the first read runs, the empty space and
 * the empty epic, the "nothing matches" card, a failed read and the not-connected entry. All of them are one card
 * (`agx-jl-empty`) with a 48 tile, one bold line, one sentence and the buttons that get the person out of it.
 * The decision of WHICH state is laneModel's `listState`; this file only draws.
 */
import type { ReactNode } from "react";
import { InboxIcon, PlusIcon, SearchIcon, WarningIcon } from "../../../lib/glyphIcons.tsx";
import { externalUrl, openExternal } from "../../../lib/externalUrl.ts";
import { ICON } from "../../../lib/iconSize.ts";
import { ago } from "../../../lib/fileRecents.ts";
import { openSettings } from "../../../lib/openSettings.ts";
import { StateDisconnected, StateError } from "../../tasks/BoardState.tsx";
import { Ctl } from "./ListControls.tsx";
import { CLEARED, keyOf, narrowedBy, type ListState } from "./laneModel.ts";
import type { JiraListFilters, JiraListModel } from "./model.ts";

const TOKEN_HELP = "https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/";

/** The plug of the not-connected card; the glyph set has no plug. */
const PlugIcon = () => (
  <svg width={ICON.xl} height={ICON.xl} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0ZM12 18v3" />
  </svg>
);

function StateCard({ icon, title, body, bad, children }: { icon: ReactNode; title: string; body?: string | undefined; bad?: boolean; children?: ReactNode }) {
  return (
    <div className="agx-jl-empty" data-bad={bad ? "" : undefined} role="status">
      <span className="ico" aria-hidden>{icon}</span>
      <b>{title}</b>
      {body && <p>{body}</p>}
      {children && <div className="acts">{children}</div>}
    </div>
  );
}

const leave = (href: string | undefined) => { openExternal(href); };
const OpenInJira = ({ href }: { href: string | undefined }) => (externalUrl(href) ? <Ctl onClick={() => leave(href)}>Open in Jira</Ctl> : null);

/** The card for a state with no lanes, or null for `lanes` and `loading`. */
export function JiraStateCard({ state, model, filters, onFilters, areaId }: {
  state: ListState; model: JiraListModel; filters: JiraListFilters; onFilters: (patch: Partial<JiraListFilters>) => void; areaId: string | null | undefined;
}) {
  const place = model.view?.name ?? "this view";
  if (state === "not-connected") {
    return (
      <StateDisconnected service="Jira" why="Add an API token and your boards, filters and epics show up here. The token stays on this machine." connectLabel="Connect Jira"
        age={model.at > 0 ? ago(model.at) : undefined} onConnect={() => openSettings("jira")} actions={<Ctl onClick={() => leave(TOKEN_HELP)}>What is a token?</Ctl>}>
        {model.at > 0 && model.cards.length > 0 && model.cards.slice(0, 12).map((c) => (
          <div key={c.id} className="agx-jl-cached text-[11.5px]" style={{ padding: "6px 16px", color: "var(--text3)" }}>{keyOf(c)} · {c.title}</div>
        ))}
      </StateDisconnected>
    );
  }
  if (state === "failed") {
    return <StateError title={`Could not read ${place}`} cause={model.error} onRetry={model.refresh} retryLabel="Try now"><OpenInJira href={model.address} /></StateError>;
  }
  if (state === "epic-0") {
    const epic = model.epics.find((e) => e.key === areaId);
    return (
      <StateCard icon={<InboxIcon size={ICON.xl} />} title="Nothing in this epic"
        body={`${epic ? `${epic.name} (${epic.key})` : "This epic"} has no cards yet. Add one in Jira and it appears here after the next read.`}>
        <Ctl tone="primary" onClick={model.refresh}>Read again</Ctl>
        <OpenInJira href={model.address} />
      </StateCard>
    );
  }
  if (state === "empty-space") {
    return (
      <StateCard icon={<InboxIcon size={ICON.xl} />} title={`Nothing in ${place} yet`}
        body="Add a card in Jira, or look one up by id. New epics show up in the sidebar on their own.">
        <OpenInJira href={model.address} />
      </StateCard>
    );
  }
  if (state === "no-match") {
    const hidden = !filters.showDone && !filters.statusPick.length ? model.counts.done : 0;
    const by = narrowedBy(filters);
    const narrowed = by.length > 0;
    const doneLine = hidden ? `${hidden} finished card${hidden === 1 ? " is" : "s are"} hidden.` : "";
    // Needs you alone and nothing left: good news, not an empty search.
    if (filters.needsOnly && by.length === 1) return (
      <StateCard icon={<SearchIcon size={ICON.xl} />} title="No agent is waiting on you" body="Every agent on these cards is working or has finished.">
        <Ctl onClick={() => onFilters({ needsOnly: false })}>Show every card</Ctl>
      </StateCard>
    );
    // Live worker alone and nothing left: no agent is on any of these cards right now, which is a fact, not a bad search.
    if (filters.liveOnly && by.length === 1) return (
      <StateCard icon={<SearchIcon size={ICON.xl} />} title="No agent is working on these cards" body="Start one from a card's main button; it shows up here while it runs.">
        <Ctl onClick={() => onFilters({ liveOnly: false })}>Show every card</Ctl>
      </StateCard>
    );
    return (
      <StateCard icon={<SearchIcon size={ICON.xl} />} title={narrowed ? "Nothing matches those filters" : "Nothing open here"}
        body={[narrowed ? `Narrowed by ${by.join(", ")}.` : "", doneLine].filter(Boolean).join(" ") || undefined}>
        {hidden > 0 && <Ctl onClick={() => onFilters({ showDone: true })}>Show {hidden} done</Ctl>}
        {narrowed && <Ctl onClick={() => onFilters(CLEARED)}>Clear filters</Ctl>}
        {!narrowed && !hidden && <Ctl onClick={model.refresh}><PlusIcon size={ICON.xs} /> Read again</Ctl>}
      </StateCard>
    );
  }
  return null;
}

/** Two lanes of three rows while the first read runs: the same shapes the lanes will have, so nothing jumps when they land. */
export function JiraSkeleton() {
  return (
    <>
      {[0, 1].map((i) => (
        <section key={i} className="agx-jl-lane" aria-hidden>
          <div className="agx-jl-head" style={{ cursor: "default" }}>
            <span className="agx-jl-tile agx-skeleton" />
            <b className="agx-skeleton" style={{ display: "block", width: 80 + i * 24, height: 12, borderRadius: 6 }} />
          </div>
          <div className="agx-jl-body">
            {[0, 1, 2].map((j) => (
              <div key={j} className="agx-jl-skrow">
                <span className="agx-jl-tile lg agx-skeleton" />
                <span className="two">
                  <b className="agx-skeleton" style={{ width: `${60 - j * 8}%` }} />
                  <b className="agx-skeleton" style={{ width: `${28 + j * 6}%`, height: 8 }} />
                </span>
                <b className="agx-skeleton" style={{ width: 72 }} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
