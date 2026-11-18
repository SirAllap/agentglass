/*
 * The sidebar's "Sync from / to Jira filter". From reads the filter's name again and keeps it here; To writes the search now in
 * the list's box into the filter on the site, and the sidebar has already asked the person. Both put what went wrong in one
 * quiet line.
 *
 * Ceiling: "from" brings the name only. A filter saved here has no JQL of its own to refresh; its search is read from Jira
 * each time it opens.
 */
import { useState } from "react";
import { api } from "./api.ts";
import { jiraSearchNow } from "./jiraSearchBus.ts";

const bare = (viewId: string) => viewId.replace(/^filter:/, "");

export function useJiraFilterSync(reload: () => Promise<unknown> | void): { note: string; from: (viewId: string) => void; to: (viewId: string) => void } {
  const [note, setNote] = useState("");
  const from = (viewId: string) => {
    void api.jiraFilter(bare(viewId)).then(async (r) => {
      if (!r.ok || !r.filter) { setNote(r.error ?? "Could not read that Jira filter"); return; }
      await api.jiraEditView(viewId, { name: r.filter.name });
      await reload();
      setNote("");
    }).catch(() => setNote("Could not read that Jira filter"));
  };
  const to = (viewId: string) => {
    const jql = jiraSearchNow().trim();
    if (!jql) { setNote("Type the search into the box first, then sync it to the filter"); return; }
    void api.jiraWriteFilter(bare(viewId), jql).then((r) => setNote(r.ok ? "" : r.error ?? "Jira did not take the change")).catch(() => setNote("Jira did not take the change"));
  };
  return { note, from, to };
}
