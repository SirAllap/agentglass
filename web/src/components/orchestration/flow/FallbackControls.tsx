/*
 * The Fallback block is the plan rule: its threshold, its engine and its switch.
 * It lives in the Flow editor's "Around the flow" row. `stacked` puts each label
 * above its control, for the editor's 292px panel.
 */
import { SettingRow } from "../../SettingRow.tsx";
import { Select } from "../../Select.tsx";
import { Button } from "../../workspace/Chrome.tsx";
import { agentProvider } from "../../../../../shared/agentKinds.ts";
import { ROLE_IDS, type Policy, type PolicyRule } from "../../../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../../../shared/types.ts";
import { LIMIT_RANGE, engineOptions, roleWord, thresholdsFor, usageWord, withFallbackEngine, withThreshold } from "../orchestrationCopy.ts";
import type { FlowLike } from "../../../lib/roleLabel.ts";

const SELECT = "agx-select rounded-lg px-2 py-1.5 text-[12px] outline-none w-[180px] justify-between";
const engineName = (id: string): string => agentProvider(id)?.title ?? id;

export function FallbackControls(p: {
  watch: PolicyRule | undefined;
  policy: Policy;
  readiness: readonly EngineReadiness[] | null;
  disabled: boolean;
  onEditRule: (r: PolicyRule) => void;
  stacked?: boolean;
  flow?: FlowLike | null;
}) {
  const watch = p.watch;
  const trig = watch?.when.find((t): t is Extract<typeof t, { kind: "usage" }> => t.kind === "usage");
  const moved = watch ? ROLE_IDS.find((r) => watch.workers?.[r]) ?? null : null;
  const chain = moved ? watch!.workers![moved]! : watch?.orchestrator;
  const options = engineOptions("worker", p.readiness);
  const thresholds = thresholdsFor(trig?.remainingAtMost ?? null);
  if (!watch) return <p className="agx-flow-p">No usage rule is set. Add one to switch engines when a plan runs low.</p>;
  const wide = p.stacked ? { wide: true } : {};
  return (
    <>
      <SettingRow {...wide} label={`When ${trig ? usageWord(trig.provider) : "a plan"} has`} hint="Counted on the plan window. The rule applies while it is at or below this."
        control={<Select value={String(trig?.remainingAtMost ?? 15)} disabled={p.disabled} title="Plan left, at most" className={SELECT}
          options={thresholds.map((v) => ({ value: String(v), label: `${v} % left` }))}
          onChange={(v) => p.onEditRule(withThreshold(watch, Number(v)))} />} />
      <SettingRow {...wide} label="Fallback engine" hint={moved ? `Takes ${roleWord(moved, p.flow)}’s turn meanwhile.` : "Takes the planned turn meanwhile."}
        control={<Select value={chain?.[0]?.engine ?? ""} disabled={p.disabled || !p.readiness} title="Fallback engine" className={SELECT}
          options={options.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(engine) => p.onEditRule(withFallbackEngine(watch, engine))} />} />
      <SettingRow {...wide} label="Then go back" hint="The rule applies by itself while its window is below the threshold. Off keeps the rule and never switches."
        control={<span className="text-[12px]" style={{ color: "var(--text2)" }}>{watch.enabled ? "on" : "off"}</span>} />
      <Button disabled={p.disabled} onClick={() => p.onEditRule({ ...watch, enabled: !watch.enabled })}>{watch.enabled ? "Turn the rule off" : "Turn the rule on"}</Button>
      <p className="agx-flow-note">{engineName(chain?.[0]?.engine ?? "")} takes the task and the worktree exactly as the Builder left them. One switch per task.</p>
      <p className="agx-flow-note">{LIMIT_RANGE.maxRetries.label}: {p.policy.limits.maxRetries}. Change it under Safety and limits.</p>
    </>
  );
}
