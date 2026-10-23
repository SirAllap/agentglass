/*
 * The pull requests a Jira card carries, in the card's pane.
 *
 * Read when the card is opened (one request, shared: lib/jiraLinks.ts) and
 * never polled. Each row opens the pull request inside agentglass, as the
 * board's chip does. Linking one writes to Jira, so the box is there only when
 * the write switch is on; with it off the section says why in one sentence.
 * Ceiling: a link is added by pasting its address, there is no picker over the
 * repository's open pull requests.
 */
import { useEffect, useState } from "react";
import { readJiraLinks, addJiraLink, type JiraLinks } from "../../lib/jiraLinks.ts";
import { api } from "../../lib/api.ts";
import { openPr, openPrs, prRefFromUrl } from "../../lib/openPrs.ts";
import { prAddress } from "../../../../shared/taskref.ts";
import { CardPrDetailRow } from "../CardPrChip.tsx";
import { EDGE, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { HIT } from "../../lib/iconSize.ts";

export const LINKING_OFF = "Linking a pull request writes to Jira, which is switched off. Turn on “Changes in Jira” in the Jira settings.";

export function openLinked(url: string, number: number): void {
  const ref = prRefFromUrl(url);
  if (ref) openPr(ref.repo, ref.number);
  else openPrs(String(number), "all");
}

/** The rows and the box, from what is already known; the data and the writing live in `JiraCardPrs`. */
export function JiraPrsView({ links, error, writable, said, busy, draft, onDraft, onLink, quiet }: {
  links: JiraLinks["links"] | null; error: string; writable: boolean; said: string; busy: boolean;
  draft: string; onDraft: (v: string) => void; onLink: () => void;
  /** The pane already says writes are off; this section then draws no box and no second sentence. */
  quiet?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0" aria-label="Pull requests">
      <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>Pull requests</div>
      {links === null && <div className="text-[10.5px]" style={{ color: "var(--text4)" }}>Reading the card's links…</div>}
      {links !== null && error && <div className="text-[10.5px]" role="status" style={{ color: "var(--warning-ink)" }}>{error}</div>}
      {links !== null && !error && !links.length && <div className="text-[10.5px]" style={{ color: "var(--text4)" }}>No pull request is linked on the card.</div>}
      {links?.map((l) => (
        <div key={l.url} className="text-[11px]">
          <CardPrDetailRow p={{ number: l.number, title: l.title, state: "", url: l.url }} onOpen={() => openLinked(l.url, l.number)} trailing={null} />
        </div>
      ))}
      {writable ? (
        <form className="flex items-center gap-2 min-w-0" onSubmit={(e) => { e.preventDefault(); if (!busy) onLink(); }}>
          <input value={draft} onChange={(e) => onDraft(e.target.value)} placeholder="Paste a pull request address"
            aria-label="Pull request address" spellCheck={false}
            className={`flex-1 min-w-0 ${INPUT}`} style={INPUT_STYLE} />
          <button type="submit" disabled={busy || !draft.trim()} className="text-[10.5px] px-2.5 rounded-lg shrink-0" style={{ border: EDGE, color: "var(--text2)", minHeight: HIT }}>
            {busy ? "Linking…" : "Link"}
          </button>
        </form>
      ) : !quiet && (
        <div className="text-[10.5px]" style={{ color: "var(--text4)" }}>{LINKING_OFF}</div>
      )}
      {said && <div className="text-[10.5px]" role="status" style={{ color: said.startsWith("!") ? "var(--warning-ink)" : "var(--success-ink)" }}>{said.replace(/^!/, "")}</div>}
    </div>
  );
}

export function JiraCardPrs({ query, writable, quiet }: { query: string; writable: boolean; quiet?: boolean }) {
  const [v, setV] = useState<JiraLinks | null>(null);
  const [draft, setDraft] = useState("");
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  // One read when the card is opened; a different card starts again.
  useEffect(() => {
    let on = true;
    setV(null); setSaid(""); setDraft("");
    void readJiraLinks(query).then((r) => { if (on) setV(r); });
    return () => { on = false; };
  }, [query]);
  const link = async () => {
    const a = prAddress(draft);
    if (!a) { setSaid("!That is not a pull request address."); return; }
    setBusy(true);
    const r = await api.jiraLink(query, a.url).catch(() => null);
    setBusy(false);
    if (!r?.ok) { setSaid(`!${r?.error || "Could not reach the server"}`); return; }
    setV(addJiraLink(query, { url: a.url, number: a.number, title: `${a.slug}#${a.number}`, resolved: false }));
    setDraft("");
    setSaid(r.linked ? "Linked on the card." : "Already linked on the card.");
  };
  return <JiraPrsView links={v?.links ?? null} error={v?.error ?? ""} writable={writable} said={said} busy={busy} draft={draft} onDraft={setDraft} onLink={() => void link()} quiet={quiet} />;
}
