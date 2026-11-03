import { SettingRow } from "../SettingRow.tsx";
import { StatusBadge } from "../SettingsKit.tsx";
import { Select } from "../Select.tsx";
import { Button, Segmented } from "../workspace/Chrome.tsx";
import { HOURS, PARAM_COPY } from "../../lib/polarisCopy.ts";
import { showsParams, type DoorView, type LimitView } from "../../lib/polarisView.ts";
import { CountParam, DoorParams } from "./DoorParams.tsx";

/** One door: its sentence, its choice of how, the settings under it, and where its value comes from. */
export function DoorRow({ v, disabled, onMode, onParams, onReset }: {
  v: DoorView; disabled: boolean;
  onMode: (mode: string) => void;
  onParams: (patch: Record<string, unknown>) => void;
  /** In a project, a door with its own value goes back to the global one. */
  onReset?: () => void;
}) {
  return (
    <SettingRow
      label={
        <span className="inline-flex flex-wrap items-center gap-2">
          {v.name}
          {v.mark && <StatusBadge tone={v.mark === "Live" ? "warn" : "off"}>{v.mark}</StatusBadge>}
          {v.isNew && <StatusBadge tone="info">New</StatusBadge>}
        </span>
      }
      hint={<>{v.what}{v.source && <> <b>{v.source}.</b></>}</>}
      detail={{ summary: "Example, and what stays yours", body: <><span>Example: {v.example}</span><br /><span>You keep: {v.keep}</span></> }}
      control={
        <span className="inline-flex items-center gap-2">
          <Segmented track label={v.name} value={v.value.mode} options={v.options} disabled={disabled} onChange={onMode} />
          {onReset && <Button size="compact" disabled={disabled} title="Take this door from the global settings again" onClick={onReset}>Use global</Button>}
        </span>
      }
      below={showsParams(v.door, v.value.mode) ? <DoorParams door={v.door} value={v.value} disabled={disabled} onChange={onParams} /> : undefined}
      wide
    />
  );
}

/** One number that caps a door, in the Limits group. Dimmed while its door is off: it takes effect when the door is on. */
export function LimitRow({ v, disabled, onChange }: { v: LimitView; disabled: boolean; onChange: (n: number) => void }) {
  const control = v.param === "hours"
    ? (
      <Select value={String(v.value)} disabled={disabled} title="Hours a pull request drifts before a course is proposed" className="agx-select rounded-lg px-2 py-1.5 text-[12px] outline-none w-[100px] justify-between"
        options={HOURS.map((h) => ({ value: String(h), label: `${h} h` }))} onChange={(h) => onChange(Number(h))} />
    )
    : <CountParam {...PARAM_COPY[v.param]} value={v.value} disabled={disabled} onChange={onChange} />;
  return (
    <SettingRow label={<span className="inline-flex flex-wrap items-center gap-2">{v.name}{!v.on && <StatusBadge tone="off">Door is off</StatusBadge>}</span>}
      hint={<>{v.hint} Belongs to “{v.doorName}”.{v.source && <> <b>{v.source}.</b></>}</>}
      control={control} />
  );
}
