import type { ReactNode } from "react";

/** A title row for one section of the Plugins page: name, a count line, then its controls. */
export function PageHead({ title, summary, children }: { title: string; summary?: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-x-3 gap-y-2 flex-wrap mb-3.5">
      <h3 className="agx-settings-head-t m-0">{title}</h3>
      {summary && <span className="text-[12px] t-dim">{summary}</span>}
      <span className="flex-1" />
      {children}
    </div>
  );
}
