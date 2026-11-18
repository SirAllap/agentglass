import type { ReactNode } from "react";

/** A heading, the content, air. No box: the Overview is calm and only blockers and the card tile are boxed. */
export function PrSection({ title, count, action, rail, children, testid }: {
  title: string; count?: ReactNode; action?: ReactNode; rail?: boolean; children: ReactNode; testid?: string;
}) {
  return (
    <section className={rail ? "prov-sec prov-railsec" : "prov-sec"} data-testid={testid} aria-label={title}>
      <div className="prov-sh">
        <h3>{title}</h3>
        {count != null && <span className="prov-cnt">{count}</span>}
        {action}
      </div>
      {children}
    </section>
  );
}
