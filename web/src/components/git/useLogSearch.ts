import { useMemo } from "react";
import type { GitGraphLine } from "../../../../shared/types.ts";
import { layoutGraph, type GraphRow } from "../../lib/gitGraph.ts";
import { commitMatches, filterKeepingSelected } from "../../lib/gitSearch.ts";

/**
 * The Log's search: the filtered lines, the lanes of the WHOLE log by hash, and
 * the selection kept through a search. Both memos run once per load or per
 * keystroke over the loaded commits; the list then mounts only its window.
 */
export function useLogSearch(graph: GitGraphLine[], q: string, selected: string | null) {
  const layout = useMemo(() => {
    const commits = graph.filter((l) => !!l.hash);
    const rows = layoutGraph(commits.map((l) => ({ hash: l.hash!, parents: l.parents ?? [] })));
    return new Map<string, GraphRow>(commits.map((l, i) => [l.hash!, rows[i]!]));
  }, [graph]);
  const found = useMemo(() => filterKeepingSelected(graph, q, commitMatches, selected), [graph, q, selected]);
  return {
    lines: found.rows, pinned: found.pinned, layout,
    /** Where the selection sits in the list a new search text would give (0 when it is pinned). */
    indexFor(next: string): number {
      const r = filterKeepingSelected(graph, next, commitMatches, selected);
      return Math.max(0, r.rows.findIndex((l) => l.hash === selected));
    },
  };
}
