/*
 * The bell in a pull request's header: "tell me when this PR's CI does X".
 *
 * A menu of rules to tick, per PR, in any combination. The rules live on the
 * server (server/src/prNotifyWatch.ts) so they keep watching with the window
 * closed; this only shows them and edits them, through the same store the board
 * reads (prWatchStore.ts) — one datum, two views.
 *
 * A one-shot rule turns itself off after it fires and the bell then shows what
 * it said; `New comment` is the exception and stays on, because comments keep
 * coming. The menu says so where the box is.
 */
import { useRef, useState } from "react";
import type { PrCheck, PrWatch, PrWatchRule } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { ICON } from "../lib/iconSize.ts";
import { suggestCheckNames } from "../lib/prWatchSuggest.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { bellState, firedLabel, firedOk, markFireSeen, useFireSeen, presetOf, ruleLabel, sameRule, usePrWatchState, watchesOf } from "../lib/prWatchStore.ts";
import { Select } from "./Select.tsx";
import { BellIcon } from "./settingsNavIcons.tsx";
import { CrossIcon, DoneIcon } from "../lib/glyphIcons.tsx";
import { Button, CTRL_H, GROUP_HEADING, INPUT, INPUT_STYLE, LINE } from "./workspace/Chrome.tsx";

const FIXED: { rule: PrWatchRule; hint?: string }[] = [
  { rule: { type: "ci-pass" } },
  { rule: { type: "ci-fail" } },
  { rule: { type: "comment" }, hint: "stays on until you turn it off — comments keep coming" },
];

/** The panel's own switch (`agx-sw`, PrPanel's stylesheet) as a row, not a native checkbox. */
/** The panel's own switch (`agx-sw`, from PrPanel's stylesheet) as a row. */
function Row({ on, onToggle, children }: { on: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={onToggle}
      className="flex items-start gap-2 px-1 py-1 text-[11px] text-left" style={{ color: "var(--text2)" }}>
      <span className="agx-sw shrink-0" data-on={on ? "1" : "0"} style={{ marginTop: 2 }} />
      <span className="min-w-0">{children}</span>
    </button>
  );
}

export function PrWatchMenu({ root, repo, d }: {
  root: string; repo: string; d: { number: number; title: string; checksAll: PrCheck[]; checks?: { allDone: boolean } };
}) {
  const state = usePrWatchState();
  const mine = watchesOf(state, repo, d.number);
  const seen = useFireSeen(repo, d.number);
  const bell = bellState(mine, seen, d.checks?.allDone ?? true);
  const preset = presetOf(state, repo);
  const [open, setOpen] = useState(false);
  const [match, setMatch] = useState("");
  const [on, setOn] = useState<"fail" | "pass" | "either">("fail");
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, box, () => setOpen(false));

  const live = mine.filter((w) => w.active);
  const waiting = (r: PrWatchRule): PrWatch | undefined => live.find((w) => sameRule(w.rule, r));
  const fail = (r: { ok: boolean; error?: string }) => setErr(r.ok ? "" : r.error ?? "could not save that");
  const toggle = async (r: PrWatchRule) => {
    const w = waiting(r);
    fail(w ? await api.prWatchRemove(w.id) : await api.prWatchAdd(root, d.number, d.title, r));
  };
  const addCheck = async () => {
    const m = match.trim();
    if (!m) return;
    await api.prWatchAdd(root, d.number, d.title, { type: "check", match: m, on }).then(fail);
    setMatch("");
  };
  const checkRules = live.filter((w) => w.rule.type === "check");
  const names = suggestCheckNames(d.checksAll, match);
  const current = live.map((w) => w.rule);

  const label = bell.kind === "on" ? `Watching ${bell.waiting}` : bell.kind === "fired" && bell.last ? firedLabel(bell.last) : "Notify";
  const tone = bell.kind === "on" ? "primary" : bell.kind === "fired" ? "ok" : "plain";
  const title = bell.kind === "off" && !bell.last?.lastText ? "Notify me when CI passes, fails, or someone comments"
    : bell.last?.lastText ? `Last: ${bell.last.lastText}` : "Watching this pull request";

  return (
    <div className="relative shrink-0 flex" ref={box}>
      <Button size="compact" tone={tone} title={title} aria-haspopup="menu" aria-expanded={open}
        data-pr-watch={bell.kind} onClick={() => {
          setOpen((v) => !v);
          // Opening it is looking at it: the fire has been seen, the button goes back to Notify.
          if (bell.kind === "fired" && bell.last?.lastAt) markFireSeen(repo, d.number, bell.last.lastAt);
        }}>
        {bell.kind === "fired" && bell.last ? (firedOk(bell.last) ? <DoneIcon size={ICON.xs} /> : <CrossIcon size={ICON.xs} />) : <BellIcon size={ICON.xs} />}{label}
      </Button>
      {open && (
        <div className="absolute z-50 top-full mt-1.5 right-0 rounded-lg agx-menu p-2 flex flex-col gap-1" style={{ minWidth: 268 }} data-pr-watch-menu>
          <div className={GROUP_HEADING} style={{ color: "var(--text4)", paddingTop: 2 }}>Notify me when…</div>
          {FIXED.map(({ rule, hint }) => (
            <Row key={rule.type} on={!!waiting(rule)} onToggle={() => void toggle(rule)}>
              {ruleLabel(rule)}{hint && <span className="block text-[10px]" style={{ color: "var(--text3)" }}>{hint}</span>}
            </Row>
          ))}
          <div className={GROUP_HEADING} style={{ color: "var(--text4)" }}>A specific check</div>
          {checkRules.map((w) => (
            <Row key={w.id} on onToggle={() => void api.prWatchRemove(w.id).then(fail)}>{ruleLabel(w.rule)}</Row>
          ))}
          <div className="flex gap-1 items-center px-1">
            <input className={`${INPUT} min-w-0 flex-1`} style={{ ...INPUT_STYLE, height: CTRL_H.compact }} value={match} placeholder="name contains, e.g. evals"
              aria-label="Check name contains" onChange={(e) => setMatch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void addCheck(); }} />
            <Select value={on} onChange={(v) => setOn(v as typeof on)} title="When the check" align="right"
              options={[{ value: "fail", label: "fails" }, { value: "pass", label: "passes" }, { value: "either", label: "either" }]} />
            <Button size="compact" onClick={() => void addCheck()} disabled={!match.trim()}>Add</Button>
          </div>
          {names.length > 0 && (
            <div className="flex flex-wrap gap-1 px-1">
              {names.map((n) => (
                <button key={n} className="agx-inline-add" onClick={() => setMatch(n)} title="A check on this pull request">{n}</button>
              ))}
            </div>
          )}
          <div style={{ borderTop: LINE, margin: "4px 0" }} />
          <div className="flex gap-1 flex-wrap px-1">
            <Button size="compact" disabled={!current.length} title={`Every rule ticked here becomes ${repo}'s default`}
              onClick={() => void api.prWatchPreset(root, current, preset?.auto ?? false).then(fail)}>Save as my default</Button>
            {preset && (
              <Button size="compact" title={preset.rules.map(ruleLabel).join(" · ")}
                onClick={() => void api.prWatchApply(root, d.number, d.title).then(fail)}>Apply my default</Button>
            )}
          </div>
          {preset && (
            <Row on={preset.auto} onToggle={() => void api.prWatchPreset(root, preset.rules, !preset.auto).then(fail)}>
              Apply automatically to my new PRs in {repo}
            </Row>
          )}
          {bell.last?.lastText && <div className="px-1 text-[10px]" style={{ color: "var(--text3)" }}>Last: {bell.last.lastText}</div>}
          {err && <div className="px-1 text-[10px]" style={{ color: "var(--error-ink)" }}>{err}</div>}
        </div>
      )}
    </div>
  );
}
