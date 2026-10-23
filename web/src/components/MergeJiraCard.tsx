import { useEffect, useState } from "react";
import { Select } from "./Select.tsx";
import { StatusPill } from "./StatusPill.tsx";
import { Spinner } from "./Spinner.tsx";
import { api } from "../lib/api.ts";
import { LEAVE_ALONE } from "../lib/cardMove.ts";
import { lookUpJiraCard, movesOffered, stepOption, stepReaches, type JiraMergeCard } from "../lib/mergeJira.ts";
import { EDGE } from "./workspace/Chrome.tsx";

type Look = { kind: "loading" } | { kind: "failed"; why: string } | { kind: "ready"; card: JiraMergeCard };

const FIELD = { background: "var(--bg)", border: EDGE, color: "var(--text)" } as const;

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

  if (look.kind === "loading") return <Spinner label={`Looking up ${ref.label} on Jira…`} className="" />;
  if (look.kind === "failed") {
    return (
      <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>
        {ref.label} — {look.why}. The merge is unaffected.
      </div>
    );
  }
  const c = look.card;
  const stepNote = !c.step || !c.writes || c.cannot ? "" : !c.step.hasMove ? "The merge step posts and links; it makes no move."
    : !stepReaches(c) ? `This card cannot make the merge step's move from where it is, so a move below is made on its own.` : "";
  const moving = pick !== LEAVE_ALONE;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[11px] font-medium" style={{ color: "var(--text2)" }}>{c.label}</span>
      <span className="text-[11px] truncate max-w-[240px]" style={{ color: "var(--text3)" }} title={c.title}>{c.title}</span>
      <span className="text-[11px]" style={{ color: "var(--text3)" }}>is in</span>
      <StatusPill status={c.status} color={c.statusColor} />
      {moving && <span className="text-[11px]" style={{ color: "var(--text3)" }}>→</span>}
      {!c.writes ? (
        <>
          <Select disabled value={LEAVE_ALONE} onChange={() => {}} title="Writing to Jira is switched off"
            className="text-[11px]" style={FIELD}
            options={[{ value: LEAVE_ALONE, label: "Leave it there" }]} />
          <button onClick={allowWrites}
            title="Let this app change cards on your Jira site. The same switch Settings owns."
            className="text-[10.5px] px-2 py-1 rounded"
            style={{ color: "var(--primary-ink)", border: EDGE }}>
            Allow Jira changes
          </button>
          <span className="text-[10px]" style={{ color: "var(--text4)" }}>— read-only until you do</span>
        </>
      ) : c.cannot ? (
        <span className="text-[10.5px]" style={{ color: "var(--text3)" }}>{c.cannot}. The merge is unaffected.</span>
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
      {stepNote && <span className="text-[10px] basis-full" style={{ color: "var(--text3)" }}>{stepNote}</span>}
    </div>
  );
}
