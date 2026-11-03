/*
 * The two-second answer: one sentence, and three cards under it that are also
 * the filter. Every number comes from `triage`, so the sentence, the cards and
 * the map cannot disagree about which containers need you.
 */
import type { ReactNode } from "react";
import { DoneIcon, WarningIcon } from "../../lib/glyphIcons.tsx";
import { MinusCircleIcon } from "./DockerIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import type { Answer, triage } from "../../lib/dockerTriage.ts";

type T = ReturnType<typeof triage>;

export function Say({ t }: { t: T }) {
  return <p className="dk-say"><b>{t.lead}</b> {t.rest}</p>;
}

/** One card that is also a filter. The Images, Volumes and Networks views draw theirs with it too. */
export function AnswerCard<A extends string>({ id, tone, icon, n, word, detail, now, active, onPick, what = "container" }: {
  id: A; tone: string; icon: ReactNode; n: number; word: string; detail: string; now: ReactNode;
  active: A | null; onPick: (a: A) => void;
  /** What "show only these" shows again when it is pressed a second time. */
  what?: string;
}) {
  const on = active === id;
  return (
    <button type="button" className="dk-ans" style={{ "--tone": tone } as React.CSSProperties} aria-pressed={on}
      disabled={!n} onClick={() => onPick(id)}
      title={n ? (on ? `Show every ${what} again` : "Show only these") : "Nothing here"}>
      <span className="dk-tile">{icon}</span>
      <span style={{ minWidth: 0 }}>
        <span className="n">{n}</span><span className="w">{word}</span>
        <div className="d">{detail}</div>
        <div className="now">NOW {now}</div>
      </span>
    </button>
  );
}

/** Pressing the card that is already on clears it. */
export function AnswerCards({ t, active, onPick }: { t: T; active: Answer | null; onPick: (a: Answer) => void }) {
  return (
    <div className="dk-answers">
      <AnswerCard id="need" tone="var(--error)" icon={<WarningIcon size={ICON.lg} />} n={t.need.length} word="Need you"
        detail={t.need.length ? t.why : "nothing is wrong"}
        now={t.needNames.length ? t.needNames.map((n, i) => <span key={n}>{i ? ", " : ""}<b>{n}</b></span>) : "all clear"}
        active={active} onPick={onPick} />
      <AnswerCard id="run" tone="var(--success)" icon={<DoneIcon size={ICON.lg} />} n={t.run.length} word="Running fine"
        detail={t.busiest ? `busiest: ${t.labelOf(t.busiest)} at ${Math.round(t.busiestCpu!)} % CPU` : "nothing is running"}
        now={`${t.webPorts} web port${t.webPorts === 1 ? "" : "s"} open${t.memory ? ` · ${t.memory} memory` : ""}`}
        active={active} onPick={onPick} />
      <AnswerCard id="stop" tone="var(--text3)" icon={<MinusCircleIcon size={ICON.lg} />} n={t.stop.length} word="Stopped"
        detail={t.stopNames.join(", ") || "nothing is stopped"}
        now={t.stop.length ? `${t.paused} paused · ${t.made} never started` : "nothing stopped on its own"}
        active={active} onPick={onPick} />
    </div>
  );
}
