/*
 * The view builder's live check: after a pause in typing, how many cards Jira finds for the search, or its error,
 * and the first five when there are any. Kept here because no file of the list pane asks the site itself.
 */
import { useEffect, useState } from "react";
import type { ProviderTask } from "../../../shared/providers.ts";
import { api } from "./api.ts";

export type JqlCheck = { s: "idle" } | { s: "checking" } | { s: "ok"; n: number } | { s: "bad"; text: string };
const COUNT_MS = 450;
const PREVIEW = 5;

export function useJqlCheck(jql: string): { check: JqlCheck; preview: ProviderTask[] | null } {
  const [check, setCheck] = useState<JqlCheck>({ s: "idle" });
  const [preview, setPreview] = useState<ProviderTask[] | null>(null);
  useEffect(() => {
    const q = jql.trim();
    if (!q) { setCheck({ s: "idle" }); setPreview(null); return; }
    setCheck({ s: "checking" });
    const ac = new AbortController();
    const t = setTimeout(() => {
      api.jiraJqlCount(q, ac.signal).then((r) => {
        if (ac.signal.aborted) return;
        setCheck(r.ok && typeof r.count === "number" ? { s: "ok", n: r.count } : { s: "bad", text: r.error || "Jira could not read that search" });
        /* The first cards only once the count says there are some: a bad or empty search costs one call, not two. */
        if (r.ok && r.count) void api.jiraJql(q, ac.signal).then((p) => { if (!ac.signal.aborted) setPreview(p.ok ? (p.tasks ?? []).slice(0, PREVIEW) : null); }).catch(() => undefined);
        else setPreview(null);
      })
        .catch(() => { if (!ac.signal.aborted) setCheck({ s: "bad", text: "Could not reach the server" }); });
    }, COUNT_MS);
    return () => { clearTimeout(t); ac.abort(); };
  }, [jql]);
  return { check, preview };
}
