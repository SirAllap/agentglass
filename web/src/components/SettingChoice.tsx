import { SettingRow, choiceIsWide, type RowDetail } from "./SettingRow.tsx";
import { Select } from "./Select.tsx";
import { Segmented } from "./workspace/Chrome.tsx";

/** A row of mutually exclusive choices, for a preference with three answers
 *  rather than two. A toggle would have forced "show me their message" and
 *  "just tell me someone wrote" to be the same decision. */
export function Choice<T extends string>({ label, hint, detail, value, options, onPick, disabled, disabledHint, modified, settingId, wide, select }: {
  /** Longer words behind a "Details" link; the hint stays one line. */
  detail?: RowDetail;
  /** See SettingRow. */
  settingId?: string; agentExempt?: boolean; agentNever?: string;
  label: string; hint: string; value: T; options: { v: T; label: string }[];
  onPick: (v: T) => void; disabled?: boolean; disabledHint?: string; modified?: boolean;
  /** Under the words in a narrow card even when the labels are short: a long hint beside two options squeezes them into a stack. */
  wide?: boolean;
  /** A kit select instead of a segmented set: for a ladder too long to read as buttons (six wake floors). */
  select?: boolean;
}) {
  return (
    <SettingRow label={label} hint={disabled ? disabledHint ?? hint : hint} detail={detail} disabled={disabled} modified={modified} settingId={settingId}
      wide={wide ?? choiceIsWide(options.map((o) => o.label))}
      control={select
        ? <Select value={value} onChange={(v) => onPick(v as T)} disabled={disabled} title={label} options={options.map((o) => ({ value: o.v, label: o.label }))} />
        : <Segmented track label={label} value={value} options={options.map((o) => ({ id: o.v, label: o.label }))} onChange={onPick} disabled={disabled} />
      } />
  );
}
