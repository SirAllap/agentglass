import type { ReactNode } from "react";

/** A section head of the Plugins page drawn like the shell's Section head: the
 *  title with its line under it, the section's one control at the right. */
export function PageHead({ id, title, summary, children }: { id: string; title: string; summary?: string; children?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-2" style={{ minHeight: 30 }}>
      <div className="min-w-0">
        <h3 id={`sec-${id}`} data-section-heading tabIndex={-1} className="text-[14px] font-semibold outline-none" style={{ color: "var(--text)" }}>{title}</h3>
        {summary && <p className="mt-0.5 text-[12px]" style={{ color: "var(--text2)" }}>{summary}</p>}
      </div>
      {children && <div className="shrink-0 flex items-center gap-2">{children}</div>}
    </div>
  );
}
