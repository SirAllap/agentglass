import type { ReactNode } from "react";
import { LINE } from "../../workspace/Chrome.tsx";
import type { SectionKind } from "./shellRules.ts";

/* The rows beside their drawing: the drawing takes a fixed 280 px at the right, and drops under the rows in a narrow column. */
const SIDE_CSS = `.agx-sec-side{container:agx-sec-side / inline-size}
.agx-sec-side-g{display:grid;grid-template-columns:minmax(0,1fr) 280px}
.agx-sec-side-g>[data-section-side]{border-left:${LINE}}
@container agx-sec-side (max-width: 620px){.agx-sec-side-g{grid-template-columns:minmax(0,1fr)}.agx-sec-side-g>[data-section-side]{border-left:0;border-top:${LINE}}}`;

/** One section: heading (and at most one preview block under the rows) (focusable, so a rail click can move focus) + optional sentence + rows. */
export function Section({ id, title, intro, kind = "normal", preview, side, action, count, children }: { id: string; title: string; intro?: string; kind?: SectionKind; /** Shown at the right of this section's rail entry. */ count?: string; preview?: ReactNode; /** A small drawing at the right of the rows, inside the same card (stacked under them in a narrow column). */ side?: ReactNode; /** One control at the right of the heading (a section-wide action). It keeps its place whatever the intro says. */ action?: ReactNode; children: ReactNode }) {
  const head = (
    <>
      <h3 id={`sec-${id}`} data-section-heading tabIndex={-1} className="text-[14px] font-semibold outline-none" style={{ color: kind === "danger" ? "var(--error-ink)" : "var(--text)" }}>
        {title}
      </h3>
      {intro && <p className="mt-0.5 text-[12px]" style={{ color: "var(--text2)" }}>{intro}</p>}
    </>
  );
  return (
    <section data-section={id} data-section-kind={kind} data-section-count={count} aria-labelledby={`sec-${id}`} className="mb-6 scroll-mt-[var(--agx-rail-band,16px)]">
      {action ? <div className="flex items-end justify-between gap-3"><div className="min-w-0">{head}</div><div className="shrink-0">{action}</div></div> : head}
      {side ? (
        <div data-section-card className="agx-sec-side mt-2 rounded-lg" style={{ background: "var(--surface-card)", border: LINE }}>
          <style>{SIDE_CSS}</style>
          <div className="agx-sec-side-g">
            <div className="min-w-0">{children}</div>
            <div data-section-side className="flex min-w-0 flex-col p-3">{side}</div>
          </div>
        </div>
      ) : <div data-section-card className="mt-2 rounded-lg" style={{ background: "var(--surface-card)", border: LINE }}>{children}</div>}
      {preview && <div data-section-preview className="mt-2 rounded-lg px-3 py-2" style={{ background: "var(--surface-card)", border: LINE }}>{preview}</div>}
    </section>
  );
}

/** Rarely changed person settings: collapsed until opened. */
export function MoreOptions({ id = "more", title = "More options", children }: { id?: string; title?: string; children: ReactNode }) {
  return (
    <section data-section={id} data-section-kind="more" className="mb-6 scroll-mt-[var(--agx-rail-band,16px)]">
      <details>
        <summary data-section-heading className="text-[14px] font-semibold cursor-pointer" style={{ color: "var(--text)" }}>{title}</summary>
        <div data-section-card className="mt-2 rounded-lg" style={{ background: "var(--surface-card)", border: LINE }}>{children}</div>
      </details>
    </section>
  );
}

/** Always last. Its actions arm, then confirm (see DangerAction in the rows). */
export function DangerZone({ id = "danger", title = "Danger zone", children }: { id?: string; title?: string; children: ReactNode }) {
  return <Section id={id} title={title} kind="danger">{children}</Section>;
}
