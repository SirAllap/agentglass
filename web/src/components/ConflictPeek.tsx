import { useEffect, useState } from "react";
import type { ConflictFile } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";
import { peekRows, type PeekRow } from "../lib/conflictPeek.ts";
import { LINE } from "./workspace/Chrome.tsx";

/**
 * A read-only look at one file a pull request would conflict on.
 *
 * Deliberately not the conflict editor: nothing here can be chosen, edited or
 * staged, because nothing is checked out. It shows what git wrote when it
 * tried the merge, so a person can tell a one-line clash from a rewrite before
 * deciding to open the real thing.
 */
type Answer = (ConflictFile & { noMarkers?: boolean }) | null;

const TINT: Record<PeekRow["kind"], string | undefined> = {
  ctx: "var(--text3)", marker: "var(--text3)", gap: "var(--text3)", base: "var(--text2)",
  ours: "var(--success-ink)", theirs: "var(--error-ink)",
};

export function ConflictPeek({ root, number, path }: { root: string; number: number; path: string }) {
  const [a, setA] = useState<Answer>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setA(null); setFailed(false);
    api.prConflictFile(root, number, path)
      .then((r) => { if (live) setA(r); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [root, number, path]);

  const note = (t: string) => <span className="block px-2 py-1" style={{ color: "var(--text3)" }}>{t}</span>;
  let body: React.ReactNode;
  if (failed) body = note("Could not read that file.");
  else if (!a) body = note("Reading…");
  else if (!a.ok) body = note(a.error ?? "Could not read that file.");
  else if (a.noMarkers) body = note("One side deleted or renamed this file while the other changed it, so git has no conflict markers to show — resolve it by keeping or dropping the file.");
  else {
    body = peekRows(a).map((r, i) => r.kind === "gap"
      ? <span key={i} className="block px-2" style={{ color: TINT.gap }}>… {r.hidden} line{r.hidden === 1 ? "" : "s"}</span>
      : (
        <span key={i} className="flex gap-2 px-2 whitespace-pre" style={{ color: TINT[r.kind] }}>
          <span className="shrink-0 w-8 text-right tabular-nums select-none" style={{ color: "var(--text3)" }}>{r.n}</span>
          <span>{r.text}</span>
        </span>
      ));
  }
  return (
    <span className="block mt-1 py-1 overflow-auto font-mono text-[10.5px] rounded"
      style={{ maxHeight: 240, border: LINE, background: "var(--surface-inset)" }}
      role="region" aria-label={`Conflicts in ${path}`}>
      {body}
    </span>
  );
}
