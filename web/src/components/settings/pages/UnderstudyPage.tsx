import { useEffect, useState } from "react";
import { LINE } from "../../workspace/Chrome.tsx";
import { SettingsPage } from "../shell/SettingsPage.tsx";
import { Section } from "../shell/Section.tsx";
import { SettingRow } from "../shell/SettingRow.tsx";
import { SHELL_SIZE } from "../shell/shellRules.ts";
import { Switch } from "../../SettingRow.tsx";
import { Teach } from "../../understudy/Teach.tsx";
import { RETENTION, setUnderstudyEnabled, useUnderstudy } from "../../understudy/UnderstudyPanel.tsx";
import { refreshUnderstudy } from "../../../lib/understudyStore.ts";
import { pushSaveToast } from "../save/index.ts";
import { registerRead, usePageLoading } from "../shell/pageLoad.tsx";
import type { PageCtx } from "./ctx.ts";

// The score lives in its own store; a hover on the nav row warms it like the page's other reads.
registerRead("understudy", "understudy/scorecard", () => refreshUnderstudy());

/** Library > Understudy: the switch saves at once (the server's answer decides what shows), then the score and what it learns from. */
export function UnderstudySettingsPage({ c }: { c: PageCtx }) {
  const frame = useUnderstudy();
  const [err, setErr] = useState<string | null>(null);
  const [showKeeps, setShowKeeps] = useState(false);
  useEffect(() => { if (c.open) void refreshUnderstudy(); }, [c.open]);
  // The switch and the score rows both wait on the scorecard: the page is not drawn until it answered.
  usePageLoading("understudy/scorecard", c.open && !frame);
  const on = !!frame?.enabled;
  const flip = (next: boolean) => {
    void setUnderstudyEnabled(next).then((r) => {
      setErr(r.ok ? null : r.error ?? "That did not work.");
      void refreshUnderstudy();
      if (r.ok) pushSaveToast("Saved", () => { void setUnderstudyEnabled(!next).then(() => refreshUnderstudy()); });
    });
  };
  const scored = (frame?.classes ?? []).filter((k) => k.n > 0).sort((x, y) => y.n - x.n);
  const idle = (frame?.classes.length ?? 0) - scored.length;
  const total = scored.reduce((n, k) => n + k.n, 0);
  const tone = (raw: number) => (raw >= 0.85 ? "var(--success)" : raw >= 0.5 ? "var(--warning)" : "var(--error)");
  const scoreSection = (
    <Section id="score" title="The score"
      intro={frame?.agreement != null ? `${Math.round(frame.agreement)} % agreed. How often the clone would have answered like you.` : "Nothing scored yet. How often the clone would have answered like you."}>
      {scored.map((k) => (
        <SettingRow key={k.id} kind="control" agentExempt label={k.label} help={`${k.n} decision${k.n === 1 ? "" : "s"}.`}
          control={
            <span className="agx-score" role="img" aria-label={`${Math.round(k.raw * 100)} % of ${k.n}`}>
              <span className="agx-btable-track" style={{ flexBasis: SHELL_SIZE.scoreBar }}><span style={{ width: `${Math.round(k.raw * 100)}%`, background: tone(k.raw) }} /></span>
              <b className="tabular-nums">{Math.round(k.raw * 100)} %</b>
            </span>
          } />
      ))}
      <SettingRow kind="control" agentExempt label={scored.length ? "Decisions recorded" : "Nothing scored yet"}
        help={scored.length ? `${idle} other kind${idle === 1 ? " has" : "s have"} no decision yet.` : "Only a decision you typed or clicked is scored."}
        control={<span className="tabular-nums text-[15px] font-semibold">{scored.length ? total.toLocaleString() : "0"}</span>} />
    </Section>
  );
  return (
    <SettingsPage
      title="Understudy"
      purpose="A clone learns how you decide and scores itself against your real answers."
      sections={[
        {
          id: "keeping-score", title: "Keeping score", kind: "normal",
          body: (
            <Section id="keeping-score" title="Keeping score">
              <SettingRow kind="control" label="Let the clone watch"
                help={frame?.halted ? "It is halted. Switch it on again to restart it." : "Off records nothing new and keeps the score."}
                control={
                  <button type="button" role="switch" aria-checked={on} aria-label="Let the clone watch" onClick={() => flip(!on)}>
                    <Switch on={on} busy={!frame} />
                  </button>
                } />
              <SettingRow kind="link" label="What it keeps" help="Only the decision and its context, never the code."
                linkText={showKeeps ? "Hide" : "Show"} onOpen={() => setShowKeeps((v) => !v)} />
              {showKeeps && (
                <p className="px-3 py-2 text-[12px]" style={{ color: "var(--text2)", borderTop: LINE }}>
                  Situations are kept {RETENTION.snapshotDays} days. The fact of a write is kept {RETENTION.stubDays} days. The score is kept for good.
                </p>
              )}
              {err && <div role="alert" className="px-3 py-2 text-[12px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
            </Section>
          ),
        },
        { id: "score", title: "The score", kind: "normal", body: scoreSection },
        { id: "learns", title: "What it learns from", kind: "normal", body: <div><Teach active={c.open} /></div> },
      ]}
    />
  );
}
