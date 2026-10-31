/*
 * The pull requests a Jira card carries, in the card's pane.
 *
 * Read when the card is opened (one request, shared: lib/jiraLinks.ts) and
 * never polled. Each row opens the pull request inside agentglass, as the
 * board's chip does. Linking one writes to Jira, so the box is there only when
 * the write switch is on; with it off the section says why in one sentence.
 * Addresses written in the card's description and comments are listed too,
 * marked as mentions. Ceiling: a mention shows its address and number, with no
 * title or state (those would cost a request per card); a link is added by
 * pasting its address, there is no picker over the
 * repository's open pull requests.
 */
import { useEffect, useState } from "react";
import { readJiraLinks, addJiraLink, withMentions, type JiraLink, type JiraLinks, type LinkWhere } from "../../lib/jiraLinks.ts";
import { approvalsOf, withDev } from "../../lib/jiraDev.ts";
import type { CardDev } from "../../../../shared/providers.ts";
import { api } from "../../lib/api.ts";
import { openPr, openPrs, prRefFromUrl } from "../../lib/openPrs.ts";
import { prAddress } from "../../../../shared/taskref.ts";
import { Author } from "./Author.tsx";
import { tipAttr } from "../../lib/tip.ts";
import { mergedInk } from "../../lib/cardPrPick.ts";
import { PullRequestIcon } from "../../lib/glyphIcons.tsx";
import { EDGE, INPUT, INPUT_STYLE } from "../workspace/Chrome.tsx";
import { HIT, ICON } from "../../lib/iconSize.ts";

export const LINKING_OFF = "Linking a pull request writes to Jira, which is switched off. Turn on “Changes in Jira” in the Jira settings.";

/** What a row says about where it came from, so a real link is told from an address somebody wrote. */
export const WHERE_LABEL: Record<LinkWhere, string> = {
  link: "linked on the card",
  comment: "mentioned in a comment",
  description: "mentioned in the description",
  dev: "known to the development tool",
};

export function openLinked(url: string, number: number): void {
  const ref = prRefFromUrl(url);
  if (ref) openPr(ref.repo, ref.number);
  else openPrs(String(number), "all");
}

/** The ring a pull request wears: open is green, merged purple, closed red, and a draft or a mention the quiet grey. */
function ringOf(l: JiraLink): { c: string; ink: string; word: string } {
  const st = l.dev?.state ?? "";
  if (st === "MERGED") return { c: "var(--merged)", ink: mergedInk(), word: "MERGED" };
  if (st === "CLOSED") return { c: "var(--error)", ink: "var(--error-ink)", word: "CLOSED" };
  if (st === "OPEN") return { c: "var(--success)", ink: "var(--success-ink)", word: "OPEN" };
  return { c: "var(--text3)", ink: "var(--text3)", word: "" };
}

/** One pull request as a tile: a facet-cut card whose ring is its state, who wrote it, where it goes, who approved. The tile is the one control: it opens the pull request here. */
export function PrTile({ l }: { l: JiraLink }) {
  const r = ringOf(l);
  const d = l.dev;
  const parts = d ? [approvalsOf(d)].filter((x): x is string => !!x) : [];
  return (
    <div className="agx-dk-prt" style={{ ["--st" as string]: r.c }}>
      <span aria-hidden className="inline-flex items-center justify-center shrink-0" style={{ width: 28, height: 28, borderRadius: 8, color: r.ink, background: `color-mix(in srgb, ${r.c} 14%, transparent)`, boxShadow: `inset 0 0 0 1.5px color-mix(in srgb, ${r.c} 55%, transparent)` }}>
        <PullRequestIcon size={ICON.md} />
      </span>
      <button type="button" onClick={() => openLinked(l.url, l.number)} data-tip={tipAttr({ name: `#${l.number}`, mono: true, text: "Open this pull request." })}
        aria-label={`Open pull request #${l.number}`} className="agx-btn flex-1 min-w-0 text-left flex flex-col" style={{ gap: 4 }}>
        <span className="truncate" style={{ fontFamily: "var(--font-prose)", fontSize: 13, fontWeight: 600, lineHeight: 1.35, color: "var(--text)" }}>{l.dev?.title || l.title || l.url}</span>
        <span className="flex items-center min-w-0" style={{ gap: 8, fontSize: 10.5, color: "var(--text3)" }}>
          <span className="tabular-nums shrink-0" style={{ color: r.ink }}>#{l.number}{r.word && ` ${r.word}`}</span>
          {d?.from && d.into && <span className="truncate min-w-0">{d.from} → {d.into}</span>}
          {d?.author && <span className="inline-flex shrink-0" aria-label={`by ${d.author}`}><Author who={d.author} size={20} /></span>}
          {parts.map((x) => <span key={x} className="shrink-0">{x}</span>)}
        </span>
        {l.where && <span style={{ fontSize: 10, color: "var(--text4)" }}>{WHERE_LABEL[l.where]}</span>}
      </button>
    </div>
  );
}

/** The rows and the box, from what is already known; the data and the writing live in `JiraCardPrs`. */
export function JiraPrsView({ links, error, writable, said, busy, draft, onDraft, onLink, quiet }: {
  links: JiraLink[] | null; error: string; writable: boolean; said: string; busy: boolean;
  draft: string; onDraft: (v: string) => void; onLink: () => void;
  /** The pane already says writes are off; this section then draws no box and no second sentence. */
  quiet?: boolean;
}) {
  return (
    <div className="flex flex-col min-w-0" style={{ gap: 8 }} aria-label="Pull requests">
      <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>Pull requests</div>
      {links === null && <div className="text-[10.5px]" style={{ color: "var(--text4)" }}>Reading the card's links…</div>}
      {links !== null && error && <div className="text-[10.5px]" role="status" style={{ color: "var(--warning-ink)" }}>{error}</div>}
      {links !== null && !error && !links.length && <div className="text-[10.5px]" style={{ color: "var(--text4)" }}>No pull request is linked on the card.</div>}
      {links?.map((l) => <PrTile key={l.url} l={l} />)}
      {writable ? (
        <form className="flex items-center min-w-0" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (!busy) onLink(); }}>
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

export function JiraCardPrs({ query, writable, quiet, mentions, dev }: {
  query: string; writable: boolean; quiet?: boolean;
  /** What the site's development tool holds for the card, read by the pane (lib/jiraDev.ts); null or absent draws nothing extra. */
  dev?: CardDev | null;
  /** Addresses in the card's own words, from the detail read the pane already made (never a request of this section's own). */
  mentions?: JiraLink[];
}) {
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
  return <JiraPrsView links={v ? withDev(withMentions(v.links, mentions ?? []), dev?.prs ?? []) : null} error={v?.error ?? ""} writable={writable} said={said} busy={busy} draft={draft} onDraft={setDraft} onLink={() => void link()} quiet={quiet} />;
}
