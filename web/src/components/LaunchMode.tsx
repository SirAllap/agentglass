/**
 * The per-item permission mode: the select in a review prompt's and a
 * Command's editor, and the quiet badge on a row whose mode is not the global
 * one. One component for both editors so the first option always reads the
 * same: "Use the global setting (Bypass)".
 */
import { LAUNCH_MODES, LAUNCH_MODE_BADGE, LAUNCH_MODE_LABEL, isLaunchMode, type LaunchMode } from "../../../shared/launchModes.ts";
import { useLaunchPermissions } from "../lib/launchMode.ts";
import { FIELD_SELECT, StatusBadge } from "./SettingsKit.tsx";
import { Select } from "./Select.tsx";

export function LaunchModeSelect({ value, onChange, label = "Permission mode" }: {
  value: LaunchMode | undefined; onChange: (m: LaunchMode | undefined) => void; label?: string;
}) {
  const global = useLaunchPermissions()?.mode;
  return (
    <Select title={label} className={FIELD_SELECT} value={value ?? ""} onChange={(v) => onChange(isLaunchMode(v) ? v : undefined)}
      options={[
        { value: "", label: global ? `Use the global setting (${LAUNCH_MODE_LABEL[global]})` : "Use the global setting" },
        ...LAUNCH_MODES.map((m) => ({ value: m, label: LAUNCH_MODE_LABEL[m] })),
      ]} />
  );
}

/** Nothing when the item follows the global mode, or names the same one. */
export function LaunchModeBadge({ mode }: { mode: LaunchMode | undefined }) {
  const global = useLaunchPermissions()?.mode;
  if (!mode || !global || mode === global) return null;
  return (
    <span title={`Starts in ${LAUNCH_MODE_LABEL[mode]}, not the global ${LAUNCH_MODE_LABEL[global]}`}>
      <StatusBadge tone="off">{LAUNCH_MODE_BADGE[mode]}</StatusBadge>
    </span>
  );
}
