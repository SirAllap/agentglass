/*
 * One Jira card in the side pane: its facts, what was written on it, and a box
 * to answer.
 *
 * The house shape for a side panel: the header (the card's facts) and the
 * composer stay put, and only what is between them scrolls. The composer is
 * the card panel's own (tasks/Composer.tsx), so the toolbar, the preview and
 * the `@` menu are the ones a ClickUp card has; who the menu offers comes from
 * Jira's people search, asked per query because Jira has no list to read whole.
 *
 * Reads: one request when a card is picked (the card with its description and
 * comments). A comment is one write and the card read back, and that answer
 * replaces the thread, so posting costs no second read here.
 */
import { openExternal } from "../../lib/externalUrl.ts";
import { noteCardLegacyKeys } from "../../lib/cardPrStore.ts";
import { isValidElement, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { api } from "../../lib/api.ts";
import { jiraDetailKey, load as remoteLoad, peek, pin, unpin, useMinuteTick, writePush } from "../../lib/remoteStore.ts";
import { tipAttr } from "../../lib/tip.ts";
import { freshComments } from "../../lib/jiraChanged.ts";
import { markCardRead, useSince } from "../../lib/jiraChangedStore.ts";
import { keyOf } from "./list/laneModel.ts";
import { putCard } from "../../lib/prCardStore.ts";
import { TRACKERS } from "../../lib/trackerApi.ts";
import { OfferedPeople } from "../../lib/trackerComment.ts";
import type { Mentionable } from "../../lib/mentions.ts";
import type { CardDev, ProviderTask, TaskDetail } from "../../../../shared/providers.ts";
import { Composer, COMPOSER_MIN } from "../tasks/Composer.tsx";
import { useDockIntent, type DockWhat } from "./list/menus/dockIntent.ts";
import { EDGE, LINE } from "../workspace/Chrome.tsx";
import { peekJiraLinks, readJiraLinks, setJiraWeb, type JiraLinks } from "../../lib/jiraLinks.ts";
import { JiraProps } from "./JiraFacts.tsx";
import { EditNote } from "./EditNote.tsx";
import { useJiraEdit, type JiraEditUi } from "./useJiraEdit.ts";
import type { JiraFollowUi } from "./useJiraFollow.ts";
import { nowOf, stepFor } from "../../lib/jiraEdit.ts";
import { keepThreads } from "../../lib/jiraThreads.ts";
import { JiraActivity, type CommentAct } from "./JiraActivity.tsx";
import { useJiraWork } from "./useJiraWork.ts";
import { useJiraFollow } from "./useJiraFollow.ts";
import { JiraDescription } from "./JiraDescription.tsx";
import { copiesLink, copiesMarkdownLink, opensComment, opensDescriptionEdit, opensAgentTab, opensInJira, opensReader, opensWork } from "../../lib/jiraReaderMode.ts";
import { LinkedBlock, WebLinksBlock, type JoinAct } from "./JiraJoins.tsx";
import { canHaveSubtasks, madeLink, webAddress } from "../../lib/jiraJoins.ts";
import { descriptionMode } from "../../lib/jiraEdit.ts";
import { emptyLine, type AddAsk } from "../../lib/stateRule.ts";
import { AttachmentsBlock, type FileAct } from "./JiraFiles.tsx";
import { LinkedSection, JiraSection, WebLinksSection } from "./JiraSections.tsx";
import { DetailHeader } from "./detail/DetailHeader.tsx";
import { LifecycleBlocks } from "./detail/LifecycleBlocks.tsx";
import { SubtaskTree } from "./detail/SubtaskTree.tsx";
import { WorkTab } from "./detail/WorkTab.tsx";
import { openCardPr, openLive, runNext } from "./detail/cardWorkActions.ts";
import { agentUrgency } from "../../lib/jiraCardWork.ts";
import { useCardLifecycle } from "./detail/useCardLifecycle.ts";
import { BoardSkeleton, CARD_BARS, StateButton, StateError, StateFold } from "../tasks/BoardState.tsx";
import { DOCK_CSS } from "./DockParts.tsx";
import { FamilyBlock, FAMILY_CSS } from "./detail/FamilyBlock.tsx";
import { JiraCardPrs } from "./JiraCardPrs.tsx";
import { JiraDevLists } from "./JiraDev.tsx";
import { CopyRow } from "../tasks/CopyRow.tsx";
import { jiraBranchName, jiraCommitCommand, jiraWorktreeCommand } from "../../lib/cardBranch.ts";
import { countsLine, peekJiraDev, readJiraDev } from "../../lib/jiraDev.ts";
import { mentionsOfCard } from "../../lib/jiraLinks.ts";
import { editRoster } from "../../lib/jiraCommentView.ts";

/** The box may grow to this share of the pane, then scrolls inside; the ClickUp card's share. */
const COMPOSER_SHARE = 0.3;
/** How long a card's detail is held for painting a remount at once (remoteStore key `jira:KEY`). */
const DETAIL_TTL_MS = 5 * 60_000;
/** Typing after `@` asks Jira once the keys have paused this long. */
const PEOPLE_WAIT_MS = 250;

type CardTab = "card" | "work" | "dev" | "activity";

type Row = Mentionable & { initials?: string; avatar?: string };

/** The card's tab strip, the house segmented track: a count after the name, the one you are on lifted. */
function DockTabs({ tabs, active, onPick }: { tabs: readonly { id: CardTab; label: string; count?: number; needs?: boolean; fresh?: number }[]; active: CardTab; onPick: (id: CardTab) => void }) {
  return (
    <div className="agx-seg" role="tablist" aria-label="Card sections">
      {tabs.map((x) => (
        <button key={x.id} type="button" role="tab" aria-selected={active === x.id} onClick={() => onPick(x.id)} className="agx-seg-b">
          {x.label}{x.needs && <span className="agx-jd-tabneeds" role="img" aria-label="an agent is waiting on you" />}{x.count ? <span className="tabular-nums" style={{ color: "var(--text3)", marginLeft: 6 }}>{x.count}</span> : null}{x.fresh ? <span className="agx-jnew agx-jnew-tab" data-testid="jira-activity-new">{x.fresh} new</span> : null}
        </button>
      ))}
    </div>
  );
}

/** What the caller's head carries that the detail head does not own: the close button and the previous/next pair. Read off the element the caller drew, so a caller that has not moved to the new props keeps both. */
function chromeOf(node: ReactNode): { onClose?: () => void; nav?: ReactNode } {
  if (!isValidElement(node)) return {};
  const p = node.props as { onClose?: () => void; nav?: ReactNode };
  return { onClose: p.onClose, nav: p.nav };
}

/* A comment half written on one card waits there while another is open, for as long as the app runs; sending it clears it. */
const DRAFTS = new Map<string, string>();

export function JiraCard({ t, header, writes, onTask, onAllow, onClose, onOpenCard, onOpenByKey, onOpenSpace, onOpenEpic, nav, onBack }: {
  t: ProviderTask;
  /** What stays above the tabs, given how to re-read this card. `updatedAt`
   *  is the cache entry's own timestamp (0 = never loaded), for "Updated N
   *  min ago" beside the refresh control. */
  header: (r: { onRefresh: () => void; refreshing: boolean; ed: JiraEditUi; follow: JiraFollowUi; onTask: (task: ProviderTask) => void; updatedAt: number }) => React.ReactNode;
  /** Whether writing to Jira is switched on; off draws a line instead of the box. */
  writes: boolean;
  /** The card as a fresher read or a write left it, for the list beside this. */
  onTask: (task: ProviderTask) => void;
  /** Ask to turn changes on, from the note at the top of the Card tab. */
  onAllow?: () => void;
  /** A right-click on a sub-task row: the list's own menu for it (slot S3). The detail's own sub-task menu (detail/SubtaskTree.tsx) answers the click now, so this is read by no one. */
  onSubtaskMenu?: (e: MouseEvent, sub: ProviderTask) => void;
  /** Close the card, and the pair that steps to the next and previous; absent, they are read off what `header` draws. */
  onClose?: () => void;
  /** Open a sub-task or the parent above this card, in place: the list under it never moves. */
  onOpenCard?: (task: ProviderTask) => void;
  /** The same, from only a key (the "Parent" field, the breadcrumb above the title). */
  onOpenByKey?: (key: string) => void;
  /** The space / epic in the header's path line: load that place in the main view. */
  onOpenSpace?: (spaceKey: string) => void;
  onOpenEpic?: (epicKey: string) => void;
  nav?: ReactNode;
  /** The way back to the card opened before this one; the header's "..." menu carries it. */
  onBack?: () => void;
}) {
  const key = t.customId ?? t.id;
  const detailKey = jiraDetailKey(key);
  /* Held for DETAIL_TTL_MS, so a remount (a terminal tab switch) paints at
     once instead of blanking — the detail is still re-read, just never
     against an empty screen while that read is in flight. Every local write
     below (`took`, an edit, a comment, …) goes through `setDetail`, which
     also keeps this cache in step, so a remount within the TTL never shows
     a stamp staler than this card's own last write. */
  const [detail, setDetailRaw] = useState<TaskDetail | null>(() => peek<{ detail: TaskDetail; more: number }>(detailKey).value?.detail ?? null);
  const setDetail = useCallback((upd: TaskDetail | null | ((d: TaskDetail | null) => TaskDetail | null)) => {
    setDetailRaw((d) => {
      const next = typeof upd === "function" ? (upd as (d: TaskDetail | null) => TaskDetail | null)(d) : upd;
      if (next) writePush<{ detail: TaskDetail; more: number }>(detailKey, { detail: next });
      return next;
    });
  }, [detailKey]);
  const [more, setMore] = useState(() => peek<{ detail: TaskDetail; more: number }>(detailKey).value?.more ?? 0);
  const [err, setErr] = useState("");
  const tok = useRef(0);
  const readAbort = useRef<AbortController | null>(null);
  /** "Still reading… Cancel": stop waiting and show the retry state the card already has. */
  const cancelRead = useCallback(() => {
    tok.current++;
    readAbort.current?.abort();
    setErr("Stopped. Nothing was read.");
  }, []);
  const onTaskRef = useRef(onTask);
  onTaskRef.current = onTask;

  const [refreshing, setRefreshing] = useState(false);
  const read = useCallback(async (force?: boolean) => {
    const mine = ++tok.current;
    const ac = new AbortController();
    readAbort.current = ac;
    try {
      const h = await remoteLoad<{ detail: TaskDetail; more: number }>(detailKey, () => api.jiraDetail(key, undefined, ac.signal).then((r) => {
        if (!r.ok || !r.detail) throw new Error(r.error || `${key} could not be read`);
        return { detail: r.detail, more: r.more ?? 0 };
      }), force ? 0 : DETAIL_TTL_MS);
      if (mine !== tok.current) return; // another card was picked meanwhile
      setDetailRaw(h.detail); setMore(h.more); setErr("");
      onTaskRef.current(h.detail.task);
    } catch (e) {
      if (mine !== tok.current) return;
      setErr(e instanceof Error ? e.message : "Could not reach agentglass");
    }
  }, [key, detailKey]);
  /* The card's own refresh: the detail read again, the same one a pick makes, no timer and no second request. */
  const refresh = useCallback(() => {
    setRefreshing(true);
    void read(true).finally(() => setRefreshing(false));
  }, [read]);

  useEffect(() => {
    setDetailRaw(peek<{ detail: TaskDetail; more: number }>(detailKey).value?.detail ?? null);
    setMore(peek<{ detail: TaskDetail; more: number }>(detailKey).value?.more ?? 0);
    setErr("");
    void read();
  }, [read]);
  /* This card is on screen: its detail entry must never be the one an LRU
     eviction picks, however many other cards get opened meanwhile. */
  useEffect(() => { pin(detailKey); return () => unpin(detailKey); }, [detailKey]);
  // A move or assign from the header, the menu or a tile answers with the card as it is now; the tiles read `detail.task`, so it takes that too or the next write sends the old stamp and conflicts.
  const took = useCallback((task: ProviderTask) => { setDetail((d) => (d ? { ...d, task } : d)); onTaskRef.current(task); }, []);

  /* A change to the card's Details: one request, whose answer is the card with its Details, so nothing is read again. */
  const editing = useJiraEdit({
    cardKey: key, stamp: (detail?.task ?? t).updated ?? 0,
    onDone: (r) => {
      setDetail((d) => (d ? { ...d, task: r.task, ...(r.facts ? { facts: r.facts } : {}), ...(r.edit ? { edit: r.edit } : {}), ...(r.description !== undefined ? { description: r.description } : {}) } : d));
      onTaskRef.current(r.task); putCard(key, r.task);
    },
    onStale: refresh,
  });
  const ed: JiraEditUi = {
    edit: writes ? detail?.edit : undefined, busy: editing.busy, run: editing.run,
    now: nowOf(detail?.task ?? t, detail?.facts, detail?.edit, detail?.description),
  };

  /* The card's remote links: one request, shared with the Development section (lib/jiraLinks.ts), so opening a card costs two in all. */
  const [links, setLinks] = useState<JiraLinks | null>(() => peekJiraLinks(key));
  useEffect(() => {
    let on = true;
    setLinks(peekJiraLinks(key)); // paint whatever is cached at once; a remount never blanks a key already read
    void readJiraLinks(key).then((r) => { if (on) setLinks(r); });
    return () => { on = false; };
  }, [key]);
  /* What the site's development tool holds, one request when the card has been read (its numeric id is in the read); null is nothing to draw. */
  const [dev, setDev] = useState<CardDev | null>(() => peekJiraDev(detail?.task.id ?? ""));
  const issueId = detail?.task.id ?? "";
  useEffect(() => {
    let on = true;
    setDev(peekJiraDev(issueId));
    if (/^\d+$/.test(issueId)) void readJiraDev(issueId).then((d) => { if (on) setDev(d); });
    return () => { on = false; };
  }, [issueId]);
  // The pull requests the card's own words name, from the read already made.
  const mentions = useMemo(() => (detail ? mentionsOfCard(detail) : []), [detail]);

  /* The composer, pinned under the thread. `replyTo` is the comment its next send answers. */
  const [tab, setTab] = useState<CardTab>("card");
  const nComments = detail?.comments.length ?? t.comments ?? 0;
  /* What is new on this card since it was last looked at, from the time held when it was opened (the board's chip goes at the open). */
  const since = useSince(t, keyOf(t));
  const fresh = useMemo(() => freshComments(detail?.comments ?? [], since), [detail?.comments, since]);
  const nFiles = detail?.attachments?.length ?? 0;
  /* The writable empty blocks fold into ONE line, "Empty: … · + Add" (docs/design-system.md, States); the Add opens the block asked for. */
  const [ask, setAsk] = useState<AddAsk>(null);
  const fold = useMemo(() => {
    const gaps: Array<{ k: NonNullable<AddAsk>["k"]; name: string; label: string }> = [];
    if (detail && writes) {
      if (!detail.description.trim() && descriptionMode(detail.edit) === "edit") gaps.push({ k: "description", name: "description", label: "Description" });
      if (!detail.subtasks.length && canHaveSubtasks(detail.task?.issueType ?? t.issueType)) gaps.push({ k: "subtask", name: "sub-tasks", label: "Sub-task" });
      if (!(detail.linked ?? []).length) gaps.push({ k: "link", name: "links", label: "Link" });
      if (links && !links.web.length) gaps.push({ k: "web", name: "web links", label: "Web link" });
      if (!nFiles) gaps.push({ k: "file", name: "files", label: "File" });
    }
    /* The Details blocks are in the line too (mockup #1): estimate, parent, sprint, labels. The sprint is read-only, so it is named and has no Add. */
    const names = gaps.map((g) => g.name);
    let est = false;
    if (detail && writes) {
      const task = detail.task ?? t;
      const noEst = (detail.facts ?? []).filter((f) => f.field === "originalEstimate" || f.field === "remainingEstimate");
      if (noEst.length && noEst.every((f) => !(f.value ?? "").trim())) { gaps.push({ k: "estimate", name: "estimate", label: "Estimate" }); names.push("estimate"); est = true; }
      if (!task.parent) { gaps.push({ k: "parent", name: "parent", label: "Parent" }); names.push("parent"); }
      if (!task.sprint) names.push("sprint");
      if (!task.tags.length) { gaps.push({ k: "labels", name: "labels", label: "Labels" }); names.push("labels"); }
    }
    const line = emptyLine(names);
    return { on: !!line, line, adds: line ? gaps : [], est: !!line && est };
  }, [detail, writes, links, nFiles, t]);
  const tabs = [
    { id: "card" as const, label: "Card" },
    { id: "work" as const, label: "Work", count: nFiles },
    { id: "dev" as const, label: "Dev" },
    { id: "activity" as const, label: "Activity", count: nComments, fresh: fresh.length },
  ];
  useEffect(() => { setTab("card"); }, [key]);
  /* A right-click "Move to / Assign to / Comment" lands here: the tab that has the control, then the control itself once it is drawn. */
  const [land, setLand] = useState<DockWhat | null>(null);
  const dockTo = (what: DockWhat) => {
    if (what === "work") { setTab("work"); return; }
    setTab(what === "comment" ? "activity" : "card"); setLand(what);
  };
  useDockIntent(t.id, dockTo);
  /* The sidebar's "With an agent" knows a card by its key only (the fleet names keys), so a request can come by key too. */
  useDockIntent(key, dockTo);
  useEffect(() => {
    if (!land) return;
    const at = document.querySelector<HTMLElement>(`[data-slot="dock"] [data-dock="${land}"]`);
    if (!at) return;
    setLand(null);
    if (land === "comment") at.querySelector<HTMLElement>("textarea")?.focus();
    else (at.matches("button") ? at : at.querySelector<HTMLElement>("button"))?.click();
  }, [land, tab, detail]);

  const [replyTo, setReplyTo] = useState<{ id: string; who: string } | null>(null);
  const [say, setSay] = useState("");
  const [saying, setSaying] = useState(false);
  const [sayErr, setSayErr] = useState("");
  /** Posted, but not everything after it went through: said as a warning. */
  const [sayWarn, setSayWarn] = useState("");
  const offered = useRef(new OfferedPeople());
  const [people, setPeople] = useState<Row[] | null>(null);
  const asking = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    setSay(DRAFTS.get(key) ?? ""); setSayErr(""); setSayWarn(""); setPeople(null); setReplyTo(null);
    offered.current = new OfferedPeople();
    return () => { if (asking.current) clearTimeout(asking.current); };
  }, [key]);
  const askPeople = useCallback((q: string) => {
    if (asking.current) clearTimeout(asking.current);
    asking.current = setTimeout(() => {
      const forKey = key;
      void api.jiraPeople(forKey, q).then((r) => {
        if (forKey !== keyRef.current) return;
        // A failed search keeps what was offered before rather than offering nobody.
        if (r.ok && r.people) setPeople(offered.current.add(r.people));
        else setPeople((p) => p ?? []);
      }).catch(() => { if (forKey === keyRef.current) setPeople((p) => p ?? []); });
    }, PEOPLE_WAIT_MS);
  }, [key]);

  const paneRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [sayCap, setSayCap] = useState(160);
  const atEnd = useRef(false);
  const sent = useRef(false);
  useEffect(() => {
    const pane = paneRef.current;
    const list = listRef.current;
    if (!pane || !list) return;
    const onScroll = () => { atEnd.current = list.scrollHeight - list.scrollTop - list.clientHeight < 4; };
    list.addEventListener("scroll", onScroll, { passive: true });
    let last = list.clientHeight;
    const ro = new ResizeObserver(() => {
      setSayCap(Math.max(COMPOSER_MIN, Math.round(pane.clientHeight * COMPOSER_SHARE)));
      // The box grew, so the thread shrank: a reader at its end stays there.
      if (list.clientHeight !== last && atEnd.current) list.scrollTop = list.scrollHeight;
      last = list.clientHeight;
    });
    ro.observe(pane); ro.observe(list);
    return () => { list.removeEventListener("scroll", onScroll); ro.disconnect(); };
  }, []);
  const count = detail?.comments.length ?? 0;
  useEffect(() => {
    if (!sent.current) return;
    sent.current = false;
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [count]);

  /* The card's stamp moved with a change to a comment: read it again, and keep the comments already paged in. */
  const restamp = async () => {
    const r = await api.jiraDetail(key).catch(() => null);
    if (r?.ok && r.detail && keyRef.current === key) { setDetail((d) => (d ? { ...d, task: r.detail!.task } : d)); onTaskRef.current(r.detail.task); }
  };
  const act: CommentAct | undefined = writes && detail?.edit ? {
    reply: detail.edit.reply,
    replyingTo: replyTo?.id ?? null,
    onReply: (c) => setReplyTo(c ? { id: c.id, who: c.who } : null),
    people,
    onPeopleQuery: askPeople,
    edit: async (c, text) => {
      // The people it already named, and anyone picked with `@` while changing it: each goes to Jira as a mention node.
      const r = await api.jiraCommentEdit(key, c.id, text, editRoster(c.mentions ?? [], offered.current.named(text))).catch(() => null);
      if (!r) return "Could not reach agentglass";
      if (!r.ok || !r.comment) return r.error || "Jira refused that change";
      const next = r.comment;
      setDetail((d) => (d ? { ...d, comments: d.comments.map((x) => (x.id === c.id ? { ...x, ...next } : x)) } : d));
      void restamp();
      return r.partial ?? null;
    },
    remove: async (c) => {
      const r = await api.jiraCommentDelete(key, c.id).catch(() => null);
      if (!r) return "Could not reach agentglass";
      if (!r.ok) return r.error || "Jira refused the delete";
      setDetail((d) => (d ? { ...d, comments: d.comments.filter((x) => x.id !== c.id), task: { ...d.task, comments: Math.max(0, (d.task.comments ?? 1) - 1) } } : d));
      setReplyTo((cur) => (cur?.id === c.id ? null : cur));
      void restamp();
      return null;
    },
  } : undefined;

  /* What the card is joined to: each change is one write whose answer is the card again (or its list of addresses), so nothing is read twice.
     The comments stay as they were: a write here did not touch them, and the answer left their threads out. */
  const take = (sent: TaskDetail) => {
    setDetail((d) => (d ? { ...sent, comments: d.comments } : sent));
    onTaskRef.current(sent.task); putCard(key, sent.task);
  };
  /* Time logged on the card: each write is one request whose answer is the card again, so nothing is read twice. The comments stay as
     they were, as for a change to what the card is joined to. Offered only while writing to Jira is on and the site tracks time here. */
  const work = useJiraWork({
    cardKey: key, stamp: (detail?.task ?? t).updated ?? 0,
    onDone: (sent) => take(sent),
    onStale: refresh,
  });

  /* Watching and voting: the account's own marks, one request each, with the counts the card was read with moved by the press. */
  const follow = useJiraFollow({
    cardKey: key, follow: detail?.follow,
    onFollow: (f) => setDetail((d) => (d ? { ...d, follow: f } : d)),
  });

  const joinAct: JoinAct = {
    subtask: async (title) => {
      const r = await api.jiraSubtask(key, title).catch(() => null);
      if (!r) return "Could not reach agentglass";
      if (!r.ok) return r.error || "Jira refused that sub-task";
      if (r.detail) take(r.detail); else void read();
      return null;
    },
    relate: async (other, way) => {
      const r = await api.jiraRelate(key, other, way.typeId, way.outward).catch(() => null);
      if (!r) return { error: "Could not reach agentglass" };
      if (!r.ok) return { error: r.error || "Jira refused that link" };
      if (r.already) return { error: `${key} ${way.phrase} ${other} is already there` };
      if (!r.detail) { void read(); return {}; }
      take(r.detail);
      return { made: madeLink(r.detail.linked, other, way) };
    },
    unrelate: async (l) => {
      const r = await api.jiraUnrelate(key, l.id).catch(() => null);
      if (!r) return "Could not reach agentglass";
      if (!r.ok) return r.error || "Jira refused that change";
      if (r.detail) take(r.detail); else void read();
      return null;
    },
    webAdd: async (url, title) => {
      const r = await api.jiraWebLink(key, url, title).catch(() => null);
      if (!r) return { error: "Could not reach agentglass" };
      if (!r.ok || !r.web) return { error: r.error || "Jira refused that address" };
      setLinks(setJiraWeb(key, r.web));
      if (r.already) return { error: "That address is already on the card" };
      const at = webAddress(url);
      return { made: r.web.find((w) => w.url === at) };
    },
    webRemove: async (w) => {
      const r = await api.jiraWebUnlink(key, w.id).catch(() => null);
      if (!r) return "Could not reach agentglass";
      if (!r.ok || !r.web) return r.error || "Jira refused that change";
      setLinks(setJiraWeb(key, r.web));
      return null;
    },
    onRowTask: (t) => setDetail((d) => (d ? { ...d, subtasks: d.subtasks.map((x) => (x.id === t.id ? t : x)) } : d)),
  };

  /* A file is one write whose answer is the card again, so nothing is read twice. */
  const fileAct: FileAct = {
    add: async (f) => {
      const r = await api.jiraAttach(key, f).catch(() => null);
      if (!r) return "Could not reach agentglass";
      if (!r.ok) return r.error || "Jira refused that file";
      if (r.detail) take(r.detail); else void read();
      return null;
    },
    remove: async (a) => {
      const r = await api.jiraUnattach(key, a.id).catch(() => null);
      if (!r) return "Could not reach agentglass";
      if (!r.ok) return r.error || "Jira refused that change";
      if (r.detail) take(r.detail); else void read();
      return null;
    },
  };

  const send = () => {
    if (!say.trim() || saying) return;
    setSaying(true); setSayErr(""); setSayWarn("");
    void TRACKERS.jira.comment(detail?.task ?? t, say, offered.current.named(say), replyTo?.id).then((r) => {
      if (!r.ok) { setSayErr(r.error || "Jira refused the comment"); return; } // the draft is kept, and so is whom it answers
      setSay(""); setReplyTo(null); DRAFTS.delete(key);
      sent.current = true;
      if (r.task) { onTaskRef.current(r.task); putCard(key, r.task); }
      if (r.detail) { const sent = r.detail; setDetail((d) => ({ ...sent, comments: keepThreads(d?.comments ?? [], sent.comments, replyTo?.id) })); setMore(r.more ?? 0); }
      else void read();
      if (r.partial) setSayWarn(r.partial);
    }).finally(() => setSaying(false));
  };

  useEffect(() => { noteCardLegacyKeys(key, detail?.description); }, [key, detail?.description]);
  const cardWork = useCardLifecycle(key, detail?.task ?? t, detail?.events);
  useMinuteTick();
  const fromHead = chromeOf(header({ onRefresh: refresh, refreshing, ed, follow, onTask: took, updatedAt: peek<{ detail: TaskDetail; more: number }>(detailKey).at }));

  /* Reader mode (`r`) and the description's own edit box (`e`). One listener for the card's life, not
     re-added on every toggle, so it stays ahead of the dock's own Esc-closes-the-card handler (see jiraReaderMode.ts). */
  const [reading, setReading] = useState(false);
  const readingRef = useRef(false);
  readingRef.current = reading;
  const writesRef = useRef(writes);
  writesRef.current = writes;
  const urlRef = useRef(t.url);
  urlRef.current = t.url;
  const liveRef = useRef(cardWork.sessions.find((s) => s.live) ?? null);
  liveRef.current = cardWork.sessions.find((s) => s.live) ?? null;
  useEffect(() => { setReading(false); }, [key]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (readingRef.current) {
        if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); setReading(false); }
        return;
      }
      if (opensReader(e, e.target)) { e.preventDefault(); setReading(true); return; }
      if (copiesMarkdownLink(e, e.target)) { const b = paneRef.current?.querySelector<HTMLButtonElement>("[data-copy-link]"); if (b) { e.preventDefault(); b.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })); } return; }
      if (copiesLink(e, e.target)) { const b = paneRef.current?.querySelector<HTMLButtonElement>("[data-copy-link]"); if (b) { e.preventDefault(); b.click(); } return; }
      if (opensComment(e, e.target) && writesRef.current) { e.preventDefault(); setTab("activity"); setLand("comment"); return; }
      if (opensWork(e, e.target)) { e.preventDefault(); setTab("work"); return; }
      if (opensAgentTab(e, e.target) && liveRef.current) { e.preventDefault(); openLive(null, liveRef.current); return; }
      if (opensInJira(e, e.target) && urlRef.current) { e.preventDefault(); openExternal(urlRef.current); return; }
      // `e` presses the description's own pencil (the chevron carries aria-expanded; the pencil does not).
      if (opensDescriptionEdit(e, e.target)) {
        const pencil = document.querySelector<HTMLButtonElement>('[aria-label="Description"] button:not([aria-expanded])');
        if (pencil) { e.preventDefault(); pencil.click(); }
      }
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);

  return (
    <div ref={paneRef} className="agx-jacc relative flex flex-col flex-1 min-w-0 min-h-0">
      <style>{DOCK_CSS}{FAMILY_CSS}</style>
      <div className="shrink-0" style={{ background: "var(--bg)" }}>
        <DetailHeader t={detail?.task ?? t} writable={writes} onTask={took} onRefresh={refresh} refreshing={refreshing} ed={ed} follow={follow}
          nav={nav ?? fromHead.nav} onBack={onBack} onClose={onClose ?? fromHead.onClose} work={cardWork} facts={detail?.facts} detail={detail} onOpenByKey={onOpenByKey} onOpenSpace={onOpenSpace} onOpenEpic={onOpenEpic} />
        <FamilyBlock card={detail?.task ?? t} detail={detail} onOpenByKey={onOpenByKey} />
        <div style={{ padding: "12px 16px 8px" }}><DockTabs tabs={cardWork.sessions.some((s) => s.live && agentUrgency(s.status) < 2) ? tabs.map((x) => (x.id === "work" ? { ...x, needs: true } : x)) : tabs} active={tab} onPick={setTab} /></div>
        {/* No height is held for what a change says: an empty reserve was a 34 px blank band under every title. The note takes its line only while there is one, and the header sits above the scroll, so no control moves. */}
        <EditNote note={editing.note} busy={!!editing.busy} onUndo={editing.undo} onClose={editing.clear} />
      </div>
      <div ref={listRef} className="agx-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col" style={{ padding: "4px 16px 16px", gap: 16 }}>
        {err && detail && <div className="text-[11px] mb-3" role="alert" style={{ color: "var(--error-ink)" }}>{err}</div>}
        {err && !detail && (
          <StateError title="Could not read this card" cause={err} where="The id is kept so you can still copy it." onRetry={refresh} retryLabel="Try now">
            <StateButton onClick={() => void navigator.clipboard?.writeText(key).catch(() => undefined)}>Copy id</StateButton>
          </StateError>
        )}
        {!detail && !err && <BoardSkeleton label="Reading the card…" widths={CARD_BARS} dots={false} onCancel={cancelRead} />}
        {detail && tab === "card" && <LifecycleBlocks life={cardWork.life} onAct={() => runNext(cardWork, () => undefined)} onPr={cardWork.pr ? () => openCardPr(cardWork.pr!) : undefined} />}
        {tab === "card" && <JiraProps folded={fold.on} estFolded={fold.est} ask={ask} t={detail?.task ?? t} writable={writes} onTask={took} facts={detail?.facts} ed={ed} onAllow={onAllow} onOpenByKey={onOpenByKey} />}
        {detail && writes && (tab === "card" || tab === "work") && <StateFold line={fold.line} adds={fold.adds.map((a) => ({ label: a.label, run: () => { setAsk({ k: a.k, n: Date.now() }); setTab(a.k === "description" || a.k === "estimate" || a.k === "parent" || a.k === "labels" ? "card" : "work"); } }))} />}
        {detail && tab === "card" && (
          <>
            <JiraDescription folded={fold.on} ask={ask} text={detail.description} edit={detail.edit} writes={writes} url={t.url} busy={editing.busy === "description"}
              onSave={(md) => { const step = stepFor("description", { value: md }, ed.now); return step ? editing.run(step) : Promise.resolve(false); }} />
          </>
        )}
        {detail && tab === "work" && <WorkTab work={cardWork} hierarchy={<>
            <SubtaskTree rows={detail.subtasks} parent={detail.task} writes={writes} act={joinAct} folded={fold.on} ask={ask} onOpenCard={onOpenCard} onRows={(rows) => setDetail((d) => (d ? { ...d, subtasks: rows } : d))} />
            {writes ? <LinkedBlock linked={detail.linked ?? []} card={key} writable act={joinAct} folded={fold.on} ask={ask} /> : <LinkedSection linked={detail.linked ?? []} />}
            {writes ? <WebLinksBlock links={links ? links.web : null} error={links?.error ?? ""} writable card={key} act={joinAct} folded={fold.on} ask={ask} /> : <WebLinksSection links={links ? links.web : null} error={links?.error ?? ""} />}
          </>} files={nFiles || writes ? <AttachmentsBlock files={detail.attachments ?? []} card={key} writable={writes} act={fileAct} folded={fold.on} ask={ask} /> : null} />}
        {detail && tab === "dev" && (
          <JiraSection id="development" title="Development" bare>
            {/* The ClickUp card's Quick start, in Jira's branch form: the key at the front is what links a branch, a commit or a pull request back to the card. */}
            <div className="flex flex-col gap-1.5 mb-2">
              <CopyRow label="Task ID" value={key} />
              <CopyRow label="Branch name" value={jiraBranchName(key, (detail.task ?? t).title)} />
              <CopyRow label="Create & checkout a new branch" value={`git checkout -b "${jiraBranchName(key, (detail.task ?? t).title)}"`} mono />
              <CopyRow label="Link a single commit" value={jiraCommitCommand(key, (detail.task ?? t).title)} mono />
              <CopyRow label="…or a worktree beside this checkout" value={jiraWorktreeCommand(key, (detail.task ?? t).title)} mono />
            </div>
            {dev && <div className="text-[10.5px] truncate" style={{ color: "var(--text3)" }} data-tip={tipAttr("What the development tool connected to this site holds for the card")}>{countsLine(dev.counts)}</div>}
            <JiraCardPrs query={key} writable={writes} quiet={!writes} mentions={mentions} dev={dev} />
            <JiraDevLists dev={dev} />
          </JiraSection>
        )}
        {detail && tab === "activity" && (
          <>
            <JiraActivity cardKey={key} cardUrl={(detail.task ?? t).url} fresh={fresh} onMarkRead={() => markCardRead(t, keyOf(t))} act={act} comments={detail.comments} moreComments={more} worklog={detail.events ?? []} worklogMore={detail.worklogMore ?? 0} tracking={detail.tracking} work={writes && detail.tracking ? work : undefined}
              onMoreComments={(page, left) => { setDetail((d) => (d ? { ...d, comments: [...d.comments, ...page] } : d)); setMore(left); }} />
          </>
        )}
      </div>

      {/* With writes off the pane has said so once, above; there is no box and no second sentence here. */}
      {writes && tab === "activity" && <div className="shrink-0" data-dock="comment" style={{ borderTop: LINE, padding: "8px 16px 12px" }}>
        {replyTo && (
          <div className="flex items-center gap-2 mb-1 text-[10.5px] min-w-0" style={{ color: "var(--text3)" }}>
            <span className="min-w-0 truncate" data-tip={tipAttr("Your comment goes in their thread")}>Replying to {replyTo.who}</span>
            <button className="agx-btn shrink-0 rounded-md px-1.5 py-0.5" onClick={() => setReplyTo(null)} style={{ color: "var(--text2)", border: EDGE }} data-tip={tipAttr("Add it as a comment of its own, not in their thread")}>Cancel reply</button>
          </div>
        )}
        <Composer value={say} growTo={sayCap} onChange={(v) => { setSay(v); setSayErr(""); if (v.trim()) DRAFTS.set(key, v); else DRAFTS.delete(key); }} busy={saying}
          placeholder={replyTo ? `Answer ${replyTo.who}. Markdown, and @ to mention somebody.` : `Comment on ${key}. Markdown, and @ to mention somebody.`}
          sendLabel={replyTo ? "Reply" : "Comment"}
          people={people}
          onNeedPeople={() => askPeople("")}
          onPeopleQuery={askPeople}
          onSend={send} />
        {sayErr && <div className="text-[10.5px] mt-1" role="alert" style={{ color: "var(--error-ink)" }}>{sayErr}</div>}
        {sayWarn && <div className="text-[10.5px] mt-1" role="status" style={{ color: "var(--warning-ink)" }}>{sayWarn}</div>}
      </div>}
      {reading && detail && (
        <div className="absolute inset-0 z-20 flex flex-col" data-slot="jira-reader" role="region" aria-label="Reader mode" style={{ background: "var(--bg)" }}>
          <div className="shrink-0 flex items-center justify-between gap-2" style={{ padding: "12px 16px", borderBottom: LINE }}>
            <div className="min-w-0">
              <div className="text-[11px]" style={{ color: "var(--text3)" }}>{key}</div>
              <div className="text-[15px] font-medium truncate">{(detail.task ?? t).title}</div>
            </div>
            <button type="button" className="agx-btn shrink-0 rounded-md px-2 py-1 text-[11px]" style={{ border: EDGE, color: "var(--text2)" }}
              aria-label="Close reader mode" data-tip={tipAttr("Esc also closes it")} onClick={() => setReading(false)}>Close</button>
          </div>
          <div className="agx-scroll flex-1 min-h-0 overflow-y-auto" style={{ padding: "16px" }}>
            <JiraDescription text={detail.description} edit={undefined} writes={false} url={(detail.task ?? t).url} busy={false} onSave={async () => false} />
          </div>
        </div>
      )}
    </div>
  );
}
