import { useId, type ReactNode } from "react";
import { rowId } from "../../../lib/settingsIndex.ts";
import { LINE } from "../../workspace/Chrome.tsx";
import { CopyButton } from "../pages/ValueView.tsx";
import { SHELL_SIZE, type RowKind } from "./shellRules.ts";
import type { LOCKED_TEXT } from "../scope/scopeModel.ts";

interface Base {
  label: string;
  /** One short sentence, 14 words at most. */
  help?: string;
  /** The setting an agent reaches through this row (src/lib/settingsRegistry.ts). Rows that are not settings leave it out. */
  settingId?: string;
  /** Marks a row that is not a setting (a link, a read-out, an action). */
  agentExempt?: boolean;
  /** A setting an agent must not reach; the text says why. */
  agentNever?: string;
  /** The scope tag under the help (ScopeTag): says whether the row follows all projects. */
  tag?: ReactNode;
  /** A value that is code (a command body, a deny rule, a path): its own muted mono line under the help. */
  code?: string;
}
export type SettingRowProps =
  | (Base & { kind: "control"; control: ReactNode })
  | (Base & { kind: "link"; href?: string; onOpen?: () => void; linkText?: string })
  | (Base & { kind: "locked"; control: ReactNode; /** The id of a note that says why, when the section says it once. */ describedBy?: string; reason: "Set by the environment" | typeof LOCKED_TEXT | (string & {}) /* "" = the section already says why */ })
  | (Base & { kind: "fact"; value: string; /** The value drawn by its kind (ValueView); the plain text stays the copy payload. */ view?: ReactNode; onCopy?: (v: string) => void });

/** Four kinds, no other: control, link, locked (disabled control + reason), fact (Inspect only). */
export function SettingRow(p: SettingRowProps) {
  const kind: RowKind = p.kind;
  const reasonId = useId();
  return (
    <div data-row-kind={kind} data-row={rowId(p.label)} {...(p.settingId ? { "data-setting-id": p.settingId } : null)} className="flex items-center justify-between gap-4 px-3 py-2.5" style={{ borderTop: LINE }}>
      <div className="flex-1 [overflow-wrap:anywhere]" style={{ minWidth: SHELL_SIZE.rowLabelMin }}>
        <div data-row-label className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>{p.label}</div>
        {p.help && <div data-row-help className="text-[12px] font-normal mt-0.5" style={{ color: "var(--text2)" }}>{p.help}</div>}
        {p.code && <div data-row-code className="font-mono text-[11px] font-normal mt-0.5 truncate" style={{ color: "var(--text2)" }}>{p.code}</div>}
        {p.tag}
        {p.kind === "locked" && p.reason && <div id={reasonId} data-row-reason className="text-[11px] font-medium" style={{ color: "var(--text2)" }}>{p.reason}</div>}
      </div>
      <div className="shrink-0 flex flex-wrap items-center justify-end gap-2" style={{ maxWidth: SHELL_SIZE.rowControlMax }}>
        {p.kind === "control" && p.control}
        {p.kind === "locked" && <div aria-disabled="true" aria-describedby={p.reason ? reasonId : p.describedBy} data-row-locked-control {...{ inert: "" }} style={{ opacity: 0.55, pointerEvents: "none" }}>{p.control}</div>}
        {p.kind === "link" && (
          <button type="button" onClick={p.onOpen} aria-label={`${p.label}: ${p.linkText ?? "Open"}`} data-row-link className="text-[12px] underline" style={{ color: "var(--accent)" }}>{p.linkText ?? "Open"}</button>
        )}
        {p.kind === "fact" && (
          <>
            {p.view ?? <span tabIndex={0} aria-label={`${p.label}: ${p.value}`} className="font-mono text-[12px] truncate max-w-[320px]" data-tip={p.value}>{p.value}</span>}
            <CopyButton label={p.label} text={p.value} onCopy={(t) => p.onCopy?.(t)} />
          </>
        )}
      </div>
    </div>
  );
}
