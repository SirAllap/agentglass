import { useEffect, useState } from "react";
import { Select } from "./Select.tsx";
import { StatusPill } from "./StatusPill.tsx";
import { Spinner } from "./Spinner.tsx";
import { api } from "../lib/api.ts";
import { LEAVE_ALONE } from "../lib/cardMove.ts";
import { lookUpJiraCard, movesOffered, stepOption, stepReaches, type JiraMergeCard } from "../lib/mergeJira.ts";
import { Button, EDGE } from "./workspace/Chrome.tsx";
import { ArrowRightIcon, TagIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import type { ReactNode } from "react";
import "./mergeDialog.css";

type Look = { kind: "loading" } | { kind: "failed"; why: string } | { kind: "ready"; card: JiraMergeCard };

const FIELD = { background: "var(--bg)", border: EDGE, color: "var(--text)" } as const;

/**
 * The tracker step's card, the same frame for either tracker: the card's id and
 * title (ellipsis, the whole title in the tooltip), then whatever the step needs
 * under it. Generic on purpose; nothing here names a tracker or a company.
 */
export function CardFrame({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="agx-mg-card" data-merge-card="">
      <div className="agx-mg-trk">
        <div className="agx-mg-trk-top">
          <span className="agx-mg-sm" aria-hidden><TagIcon size={ICON.sm} /></span>
          <b className="agx-mg-trk-id">{label}</b>
          {title && <span className="agx-mg-trk-title" data-tip={title}>{title}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** "old -> new": the pill the card is in, and where it goes when something other than "Leave it there" is picked. */
export function MovePills({ from, fromColor, to, toColor, toDim }: { from: string; fromColor?: string; to?: string; toColor?: string; toDim?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0 flex-wrap" data-merge-move="">
      <StatusPill status={from} color={fromColor} />
      {to && <><span aria-hidden className="agx-mg-quiet flex"><ArrowRightIcon size={ICON.sm} /></span><StatusPill status={to} color={toColor} dim={toDim} /></>}
    </span>
  );
}

/**
 * Where a Jira card goes when the merge lands. Every status and move on screen
 * is the site's own word; the row opens on "Leave it there", so nothing is
 * written unless a move is picked.
 */
export function MergeJiraCard({ card: ref, pick, onPick }: {
  card: { label: string; query: string };
  pick: string;
  onPick: (card: JiraMergeCard | null, key: string) => void;
}) {
  const [look, setLook] = useState<Look>({ kind: "loading" });

  const load = async (alive: () => boolean) => {
    const r = await lookUpJiraCard(ref);
    if (!alive()) return;
    if (r.ok) { setLook({ kind: "ready", card: r.card }); onPick(r.card, stepOption(r.card)?.key ?? LEAVE_ALONE); }
    else { setLook({ kind: "failed", why: r.why }); onPick(null, LEAVE_ALONE); }
  };

  useEffect(() => {
    let live = true;
    setLook({ kind: "loading" });
    void load(() => live);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.query]);

  /* The same switch Settings owns, turned on where it stopped the person. */
  const allowWrites = async () => {
    setLook({ kind: "loading" });
    await api.jiraWrites(true).catch(() => null);
    await load(() => true);
  };

  if (look.kind === "loading") return <CardFrame label={ref.label}><Spinner label={`Looking up ${ref.label} on Jira…`} className="" /></CardFrame>;
  if (look.kind === "failed") {
    return (
      <CardFrame label={ref.label}>
        <div className="agx-mg-quiet">{look.why}. The merge is unaffected.</div>
      </CardFrame>
    );
  }
  const c = look.card;
  const stepNote = !c.step || !c.writes || c.cannot ? "" : !c.step.hasMove ? "The merge step posts and links; it makes no move."
    : !stepReaches(c) ? `This card cannot make the merge step's move from where it is, so a move below is made on its own.` : "";
  const moving = pick !== LEAVE_ALONE;
  const target = moving ? movesOffered(c).find((o) => o.key === pick) : undefined;
  return (
    <CardFrame label={c.label} title={c.title}>
      <div className="agx-mg-trk-move">
        <MovePills from={c.status} fromColor={c.statusColor} to={target?.label} toColor={target?.color} toDim={target?.toKind === "done"} />
        <span className="ml-auto flex items-center gap-2 flex-wrap justify-end">
          {!c.writes ? (
            <>
              <Select disabled value={LEAVE_ALONE} onChange={() => {}} title="Writing to Jira is switched off"
                className="text-[11px]" style={FIELD}
                options={[{ value: LEAVE_ALONE, label: "Leave it there" }]} />
              <Button size="compact" onClick={allowWrites}
                title="Let this app change cards on your Jira site. The same switch Settings owns.">
                Allow Jira changes
              </Button>
            </>
          ) : c.cannot ? (
            <span className="agx-mg-quiet">{c.cannot}. The merge is unaffected.</span>
          ) : (
            <Select
              value={pick}
              onChange={(v) => onPick(c, v)}
              align="left"
              title="Where this card goes when the merge lands"
              className="text-[11px]"
              style={FIELD}
              options={[
                { value: LEAVE_ALONE, label: "Leave it there" },
                ...movesOffered(c).map((o) => ({
                  value: o.key, label: o.label, tint: o.color, pill: true, dim: o.toKind === "done",
                  ...(o.needs?.length ? { disabled: true, hint: `needs ${o.needs.join(", ")}` } : null),
                })),
              ]}
            />
          )}
        </span>
      </div>
      {!c.writes && <span className="agx-mg-quiet" style={{ fontSize: 10.5 }}>Read-only until you allow changes.</span>}
      {stepNote && <span className="agx-mg-quiet" style={{ fontSize: 10.5 }}>{stepNote}</span>}
    </CardFrame>
  );
}
