/**
 * The per-item permission mode: the select in a review prompt's and a
 * Command's editor, and the quiet badge on a row whose mode is not the global
 * one. One component for both editors so the first option always reads the
 * same: "Use the global setting (Bypass)".
 */
import type { CSSProperties } from "react";
import { LAUNCH_MODES, LAUNCH_MODE_BADGE, LAUNCH_MODE_LABEL, isLaunchMode, type LaunchMode } from "../../../shared/launchModes.ts";
import { useLaunchPermissions } from "../lib/launchMode.ts";
import { StatusBadge } from "./SettingsKit.tsx";

export function LaunchModeSelect({ id, value, onChange, className, style }: {
  id: string; value: LaunchMode | undefined; onChange: (m: LaunchMode | undefined) => void;
  className: string; style: CSSProperties;
}) {
  const global = useLaunchPermissions()?.mode;
  return (
    <select id={id} value={value ?? ""} className={className} style={style}
      onChange={(e) => onChange(isLaunchMode(e.target.value) ? e.target.value : undefined)}>
      <option value="">{global ? `Use the global setting (${LAUNCH_MODE_LABEL[global]})` : "Use the global setting"}</option>
      {LAUNCH_MODES.map((m) => <option key={m} value={m}>{LAUNCH_MODE_LABEL[m]}</option>)}
    </select>
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
