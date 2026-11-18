import type { ReactNode } from "react";

/*
 * House component for the states pattern. Branch states1 adds the shared rule in
 * web/src/lib/stateRule.ts and the Jira screens: at merge those screens should
 * import this one rather than keep a copy.
 */
/**
 * One calm line for "there is nothing here": a quiet note that replaces a stack of
 * empty boxes. `tone="ok"` draws it as a clean verdict, `tone="warn"` as a nudge.
 */
export function EmptyState({ tone, children, hint }: { tone?: "ok" | "warn"; children: ReactNode; hint?: ReactNode }) {
  const ink = tone === "ok" ? "var(--success)" : tone === "warn" ? "var(--warning)" : "var(--text3)";
  return (
    <div data-empty-state={tone ?? "quiet"} className="flex flex-col gap-0.5">
      <span className="text-[11px]" style={{ color: ink }}>{children}</span>
      {hint && <span className="text-[10px]" style={{ color: "var(--text4)" }}>{hint}</span>}
    </div>
  );
}
