/*
 * The selection bar's second action: "Request review…" for every picked pull request (mockup states 8-12).
 *
 * The reviewer is picked with the same PeoplePicker the one-PR flow uses (one person, reviewers only). Under it, ONLY
 * when picked pull requests link a task in a connected tool, one block per tool, named from the link: "Assign <name>"
 * and "Move to <status>", with today's starting values (ClickUp: its review step; Jira: off). The foot says the plan in
 * one line and that there is no undo. Nothing is written before the button. Apply sends every GitHub request first,
 * then the tasks, and the popover turns into one row per pull request with Retry failed.
 *
 * The decisions are lib/prBulkAsk.ts; the writes are the one-PR picker's own endpoints (api.prReviewers,
 * api.clickupCard, the Jira tracker seam), one pull request or one task per call.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { PrSummary } from "../../../shared/types.ts";
import type { ListStatus, ProviderTask } from "../../../shared/providers.ts";
import { api } from "../lib/api.ts";
import { DoneIcon, InfoIcon, LinkIcon, LockIcon, UserPlusIcon, WarningIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { askView, type AskRow } from "../lib/prAskWho.ts";
import { askSource } from "../lib/prPeopleSource.ts";
import { nextStatuses, type TrackerKind } from "../lib/prHandOver.ts";
import {
  bulkPlan, bulkRows, bulkSummary, canSend, failedParts, moveOffer, partsOf, resultLine, rowCounts, runBulk, startParts, toolDefaults, toolsOf, TOOL_NAME, writesTo, runBusy, ghSkipNote,
  type BulkOut, type BulkPr, type BulkWriters, type Outcome, type ToolPick, type ToolState, type Which, type Who,
} from "../lib/prBulkAsk.ts";
import { cardOf, onCard, putCard } from "../lib/prCardStore.ts";
import { mergeCardRefOrRow, reviewStatus } from "../lib/cardMove.ts";
import { cardWriteBlock } from "../lib/cardWrites.ts";
import { useJiraSettings } from "../lib/jiraSettings.ts";
import { useClickupPrefs } from "../lib/clickupPrefs.ts";
import { useClickupSetup } from "../lib/clickupSetup.ts";
import { useOwnerSetup } from "../lib/trackerView.ts";
import { readLinks, withLink, writeLinks } from "../lib/prCardPeople.ts";
import { loadPairs, pairPick, pairRows, recordPairs, type JiraPair } from "../lib/jiraPairs.ts";
import { listMembers } from "../lib/listMembers.ts";
import { recordPicks, loadUse } from "../lib/personUsage.ts";
import { TRACKERS, type StatusOption } from "../lib/trackerApi.ts";
import { hasExtras, planOf, touchesPeople } from "../../../shared/stepBlocks.ts";
import { useDismiss } from "../lib/useDismiss.ts";
import { PeoplePicker, type PickerLoad } from "./workspace/PeoplePicker.tsx";
import { TrackerBadge } from "./TrackerBadge.tsx";
import { Button, INPUT, INPUT_STYLE } from "./workspace/Chrome.tsx";

const UNREACHABLE = "Could not reach the server";
const lc = (s: string) => s.trim().toLowerCase();
const fail = (error?: string): Outcome => ({ state: "fail", ...(error && error !== UNREACHABLE ? { error } : null) });

interface Linked { number: number; kind: TrackerKind; label: string; query: string }
type Opts = Record<number, StatusOption[] | null>;

export function PrBulkAsk({ root, repo, picked, open, onOpen, onDone }: {
  root: string; repo: string;
  picked: readonly PrSummary[];
  open: boolean;
  onOpen: (open: boolean) => void;
  /** Close pressed on the results: the selection is cleared, as after Tell me when. */
  onDone: () => void;
}): ReactElement {
  const n = picked.length;
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  const setup = useOwnerSetup(useClickupSetup(), repo || undefined);
  const jiraSettings = useJiraSettings();
  const reviewPrefs = useClickupPrefs()?.review;
  const [, redraw] = useState(0);
  useEffect(() => onCard(() => redraw((x) => x + 1)), []);

  /* ---- who ---- */
  const [users, setUsers] = useState<string[] | null>(null);
  const [load, setLoad] = useState<PickerLoad>("loading");
  const [whoLogin, setWho] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const readUsers = () => {
    setLoad("loading");
    void api.prMentions(root).then((m) => { if (m.ok && m.data) { setUsers(m.data.users); setLoad("ready"); } else setLoad("error"); }).catch(() => setLoad("error"));
  };
  useEffect(() => { if (open && users === null) readUsers(); }, [open, root]); // eslint-disable-line react-hooks/exhaustive-deps
  const who: Who | null = whoLogin ? { login: whoLogin, name: whoLogin } : null;
  const src = useMemo(() => askSource({ mode: "reviewers", author: "", roster: [], users: users ?? [], assignable: [], assigned: [], owners: [], use: loadUse() }), [users]);
  const view = useMemo(() => askView({
    mode: "reviewers", author: "", repo, people: src.people, teams: [], asked: [], suggested: src.suggested, picked: whoLogin ? [whoLogin] : [], query,
  }), [repo, src, whoLogin, query]);

  /* ---- the linked tasks, read only while open ---- */
  const linked = useMemo<Linked[]>(() => picked.flatMap((p) => {
    const ref = mergeCardRefOrRow(p, setup);
    return ref ? [{ number: p.number, kind: ref.tracker === "jira" ? "jira" as const : "clickup" as const, label: ref.label, query: ref.query }] : [];
  }), [picked, setup]);
  const taskOf = (l: Linked): ProviderTask | null => (open ? cardOf(l.query, undefined, l.kind)?.task ?? null : null);
  const tasks = new Map(linked.map((l) => [l.number, taskOf(l)] as const));
  const [opts, setOpts] = useState<Opts>({});
  const taskKey = linked.map((l) => `${l.number}:${tasks.get(l.number)?.id ?? ""}:${tasks.get(l.number)?.status ?? ""}`).join("|");
  useEffect(() => {
    if (!open) return;
    let live = true;
    for (const l of linked) {
      const t = tasks.get(l.number);
      if (!t) continue;
      void TRACKERS[l.kind].statusOptions(t).then((r) => r.ok ? (r.data ?? []) : []).catch(() => [] as StatusOption[])
        .then((o) => { if (live) setOpts((m) => ({ ...m, [l.number]: o })); });
    }
    return () => { live = false; };
  }, [open, taskKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const prs: BulkPr[] = picked.map((p) => {
    const l = linked.find((x) => x.number === p.number);
    const t = l ? tasks.get(p.number) : null;
    const o = opts[p.number];
    const moves = o ? o.filter((x) => !x.needs?.length).map((x) => x.toStatus) : null;
    return {
      number: p.number, title: p.title, author: p.author, asked: (p.reviewers ?? []).filter((r) => !r.isTeam).map((r) => r.login),
      task: l ? { kind: l.kind, id: l.label, status: t?.status ?? p.card?.status ?? "", moves, ...(t ? null : { unread: true }) } : null,
    };
  });
  const kinds = toolsOf(prs);

  /* ---- per tool: links, writes, starting values ---- */
  const [linksTick, setLinksTick] = useState(0);
  const [pairs, setPairs] = useState<JiraPair[]>([]);
  useEffect(() => { if (!open) return; let live = true; void loadPairs().then((p) => { if (live) setPairs(p); }); return () => { live = false; }; }, [open]);
  const links = useMemo(() => ({ clickup: readLinks("clickup"), jira: readLinks("jira") }), [linksTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const tools: Partial<Record<TrackerKind, ToolState>> = {};
  for (const k of kinds) {
    const link = whoLogin ? links[k][lc(whoLogin)] : undefined;
    tools[k] = { linked: link?.name ?? null, blocked: cardWriteBlock(k, setup, jiraSettings) };
  }
  /* ClickUp's review step, read the way the one-PR picker reads it (PrAskPicker.tsx `usePrCardSide`). */
  const menuPlan = reviewPrefs ? planOf("menu", reviewPrefs) : null;
  const stepOn = reviewPrefs?.enabled === true && !!menuPlan && (!!menuPlan.move || touchesPeople(menuPlan) || hasExtras(menuPlan));
  const offerOf = (k: TrackerKind) => moveOffer(prs.filter((p) => p.task?.kind === k && p.task.moves).map((p) => nextStatuses(k, p.task!.status, p.task!.moves!)));
  const reviewToOf = (k: TrackerKind): string => {
    if (k !== "clickup" || !stepOn || !menuPlan?.move) return "";
    const names = menuPlan.move.names ?? [];
    if (!names.length && !menuPlan.move.fallback) return "";
    for (const p of prs) {
      if (p.task?.kind !== "clickup") continue;
      const o = opts[p.number];
      if (!o) continue;
      const hit = reviewStatus(o.map((x, i): ListStatus => ({ status: x.toStatus, type: x.toKind === "done" ? "done" : "open", orderindex: i })), p.task.status, names);
      if (hit) return hit;
    }
    return "";
  };
  const [chosen, setChosen] = useState<Partial<Record<TrackerKind, Partial<ToolPick>>>>({});
  const picks: Partial<Record<TrackerKind, ToolPick>> = {};
  for (const k of kinds) {
    const offer = offerOf(k);
    const base = toolDefaults(k, { ...(k === "clickup" && reviewPrefs?.assignReviewer ? { assignReviewer: true } : null), reviewTo: reviewToOf(k), offer });
    picks[k] = { ...base, ...chosen[k] };
  }
  const setPick = (k: TrackerKind, p: Partial<ToolPick>) => setChosen((c) => ({ ...c, [k]: { ...c[k], ...p } }));

  const items = bulkPlan({ prs, who, picks, tools });
  const summary = bulkSummary(items, who);

  /* ---- linking a login to a tool account ---- */
  const [linking, setLinking] = useState<TrackerKind | null>(null);
  const [lq, setLq] = useState("");
  const [found, setFound] = useState<{ key: string; name: string; email?: string }[]>([]);
  useEffect(() => {
    if (!linking || !whoLogin) { setFound([]); return; }
    const first = prs.find((p) => p.task?.kind === linking);
    const t = first ? tasks.get(first.number) : null;
    let live = true;
    const q = lq.trim().toLowerCase();
    const timer = setTimeout(() => {
      if (linking === "jira") {
        if (!q || !t) { setFound(pairRows([whoLogin], pairs).map((p) => ({ key: p.key, name: p.name, ...(p.email ? { email: p.email } : null) }))); return; }
        void TRACKERS.jira.people!(t, q).then((r) => { if (live) setFound(r.ok ? (r.data ?? []).map((x) => ({ key: x.key, name: x.name, ...(x.email ? { email: x.email } : null) })) : []); }).catch(() => { if (live) setFound([]); });
      } else if (t?.listId) {
        void listMembers(t.listId).then((r) => {
          if (!live) return;
          const all = r?.ok ? (r.members ?? []) : [];
          setFound(all.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.email ?? "").toLowerCase().includes(q)).slice(0, 6).map((m) => ({ key: String(m.id), name: m.name, ...(m.email ? { email: m.email } : null) })));
        }).catch(() => { if (live) setFound([]); });
      }
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [linking, lq, whoLogin, pairs, taskKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const linkTo = (k: TrackerKind, person: { key: string; name: string }) => {
    if (!whoLogin) return;
    writeLinks(k, withLink(links[k], whoLogin, { key: person.key, ident: person.key, name: person.name }));
    setLinksTick((x) => x + 1);
    setPick(k, { assign: true });
    setLinking(null); setLq("");
  };

  /* ---- running ---- */
  const [out, setOut] = useState<BulkOut | null>(null);
  const live = useRef({ items, tasks, opts, who, linked });
  live.current = { items, tasks, opts, who, linked };
  const writers: BulkWriters = {
    github: async (num) => {
      const r = await api.prReviewers(root, num, [live.current.who!.login], []).catch(() => ({ ok: false, error: UNREACHABLE }));
      return r.ok ? { ok: true } : { ok: false, ...(r.error && r.error !== UNREACHABLE ? { error: r.error } : null) };
    },
    card: async (job) => {
      const { tasks: ts, opts: os, who: w, linked: ls } = live.current;
      const t0 = ts.get(job.number);
      const query = ls.find((l) => l.number === job.number)?.query ?? "";
      /* Never sent: the plan skips a task not read yet, so this is only a task that went away since. */
      if (!t0 || !w) { const ns: Outcome = { state: "fail", notSent: true }; return { ...(job.assign ? { assign: ns } : null), ...(job.to ? { move: ns } : null) }; }
      const link = readLinks(job.kind)[lc(w.login)];
      if (job.kind === "clickup") {
        const r = await api.clickupCard(t0.id, {
          ...(job.assign && link ? { add: [Number(link.key)] } : null), ...(job.to ? { status: job.to } : null),
        }, t0.updated).catch(() => ({ ok: false as const, error: UNREACHABLE, task: undefined }));
        if (r.ok && r.task) putCard(query, r.task);
        const o = r.ok ? { state: "ok" as const } : fail(r.error);
        return { ...(job.assign ? { assign: o } : null), ...(job.to ? { move: o } : null) };
      }
      const res: Partial<Record<"assign" | "move", Outcome>> = {};
      let task = t0;
      if (job.assign && link) {
        const r = await TRACKERS.jira.setPeople!(task, { set: link.key }).catch(() => ({ ok: false, error: UNREACHABLE }) as { ok: boolean; error?: string; conflict?: boolean; task?: ProviderTask });
        if (r.ok) { if (r.task) { task = r.task; putCard(query, r.task); } res.assign = { state: "ok" }; void recordPairs(pairPick([w.login], { key: link.key, name: link.name })); }
        else res.assign = fail(r.conflict ? "somebody changed this card while you had it open" : r.error);
      }
      if (job.to) {
        const opt = (os[job.number] ?? []).find((x) => x.toStatus === job.to);
        if (!opt) res.move = fail(`${job.to} is not a move this card can make from here`);
        else {
          const r = await TRACKERS.jira.setStatus(task, opt).catch(() => ({ ok: false, error: UNREACHABLE }) as { ok: boolean; error?: string; conflict?: boolean; task?: ProviderTask });
          if (r.ok) { if (r.task) putCard(query, r.task); res.move = { state: "ok" }; }
          else res.move = fail(r.conflict ? "somebody changed this card while you had it open" : r.error);
        }
      }
      return res;
    },
  };
  /* The plan as it was pressed: the rows report on it, not on whatever the board redraws to. */
  const [sent, setSent] = useState<{ items: typeof items; who: Who } | null>(null);
  /* Each run has an id; an answer from a run that is no longer current (closed, reset) is dropped. */
  const run = useRef(0);
  const go = (its: typeof items, w: Who, which: Which) => {
    const id = ++run.current;
    setOut((o) => startParts(o ?? {}, which));
    void runBulk(its, which, writers, (num, o) => { if (run.current === id) setOut((prev) => ({ ...(prev ?? {}), [num]: { ...(prev?.[num] ?? {}), ...o } })); });
  };
  const apply = () => {
    if (!who || !canSend(items, who)) return;
    recordPicks([who.login]);
    setSent({ items, who });
    go(items, who, partsOf(items));
  };
  const reset = () => { run.current += 1; setOut(null); setSent(null); setLinking(null); setLq(""); setChosen({}); };
  const busy = runBusy(out);
  /* While a write is out nothing closes it (outside press, Escape, the trigger, Close), and the selection stays. */
  const close = () => { if (busy) return; if (out) { reset(); onOpen(false); onDone(); } else onOpen(false); };
  useEffect(() => { if (!n && !busy) { reset(); onOpen(false); } }, [n, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useDismiss(open && !!out && !busy, box, () => close());

  /* ---- drawing ---- */
  const skipNote = ghSkipNote(items, who);
  const withTask = items.filter((x) => x.task);
  const noTask = items.filter((x) => !x.task);
  const toolBlock = (k: TrackerKind) => {
    const tool = TOOL_NAME[k];
    const mine = prs.filter((p) => p.task?.kind === k);
    const st = tools[k]!;
    const pk = picks[k]!;
    const counts = mine.reduce<Record<string, number>>((m, p) => ((m[p.task!.status || "unknown"] = (m[p.task!.status || "unknown"] ?? 0) + 1), m), {});
    const nowWords = Object.entries(counts).map(([s, c]) => `${s} (${c})`).join(", ");
    const cant = items.filter((x) => x.task?.kind === k && x.task.cant).map((x) => `${x.task!.id} cannot make this move from here. It is skipped.`);
    const offer = offerOf(k);
    const off = !!st.blocked;
    const login = whoLogin ?? "the reviewer";
    return (
      <div key={k} className="rr-grp" role="group" aria-label={`${tool} tasks`}>
        <div className="rr-gh"><TrackerBadge tracker={k} /><span className="ids">{mine.map((p) => p.task!.id).join(", ")}</span><span style={{ flex: "none" }}>· now {nowWords}</span></div>
        {off ? <div className="rr-none"><LockIcon size={ICON.xs} /><span>{st.blocked}</span></div> : <>
          <button type="button" className="rr-sw" role="switch" aria-checked={pk.assign && !!st.linked} aria-disabled={!st.linked || !who}
            onClick={() => { if (st.linked && who) setPick(k, { assign: !pk.assign }); }}>
            <span className="trk" /><span><span className="tt">Assign {login}</span><span className="ex">
              {!who ? "Pick a reviewer first."
                : !st.linked ? <><span className="warn">{login} is not linked to a {tool} person on this machine yet.</span>{" "}
                  <span role="button" tabIndex={0} className="rr-link" onClick={(e) => { e.stopPropagation(); setLinking(linking === k ? null : k); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setLinking(linking === k ? null : k); } }}><LinkIcon size={ICON.xs} />Link {login} to…</span></>
                : <><b>{login}</b> is <b>{st.linked}</b> on {tool}. {k === "jira" ? "Replaces who is on it now: a Jira task holds one person." : `Adds ${st.linked}; the people on it stay.`}
                  {k === "clickup" && <><br />On by default: Settings ▸ ClickUp ▸ review step.</>}</>}
            </span></span>
          </button>
          {linking === k && who && (
            <div className="rr-linkbox">
              <input className={`${INPUT} w-full`} style={INPUT_STYLE} autoFocus value={lq} onChange={(e) => setLq(e.target.value)} placeholder={`Find ${login} on ${tool}`} aria-label={`Find ${login} on ${tool}`} />
              {found.map((f) => (
                <button key={f.key} type="button" className="rr-p" onClick={() => linkTo(k, f)}><UserPlusIcon size={ICON.xs} /><span>{f.name}{f.email && <span className="lg">{f.email}</span>}</span></button>
              ))}
            </div>
          )}
          <div className="rr-sw" role="group">
            <button type="button" role="switch" aria-checked={pk.move} aria-label={`Move ${tool} tasks`} className="rr-trk-btn" onClick={() => setPick(k, { move: !pk.move })}><span className="trk" /></button>
            <span><span className="tt">Move to
              <select className="rr-sel" value={pk.to} aria-label={`${tool} status`} onChange={(e) => setPick(k, { to: e.target.value, move: true })}>
                {(offer.includes(pk.to) || !pk.to ? offer : [pk.to, ...offer]).map((s) => <option key={s} value={s}>{s}</option>)}
              </select></span>
              <span className="ex">The same move one PR makes today.{cant.length ? <> <span className="warn">{cant.join(" ")}</span></> : null}</span></span>
          </div>
        </>}
      </div>
    );
  };

  const results = (() => {
    if (!out || !sent) return null;
    const rows = bulkRows(sent.items, out, sent.who);
    const c = rowCounts(rows);
    const again = failedParts(out);
    const ic = { done: <DoneIcon size={ICON.xs} />, failed: <WarningIcon size={ICON.xs} />, skipped: <InfoIcon size={ICON.xs} />, busy: <InfoIcon size={ICON.xs} /> };
    const word = { done: "Done", failed: "Failed", skipped: "Skipped", busy: "Working" };
    const cell = (x: (typeof rows)[number]["gh"]) => <div className="rr-c" data-st={x.st}>{ic[x.st]}<span><b>{x.head}</b> · {word[x.st]}<br /><span className="why">{x.text}</span></span></div>;
    return (
      <div className="pw-pop rr-pop" data-bulk role="dialog" aria-label={`Results for ${n} pull requests`} data-bulk-ask-results style={{ maxHeight: "min(560px, calc(100vh - 140px))" }}>
        <div className="pw-body">
          <div className="pw-q">Request a review<small>{c.done} done · {c.failed} failed · {c.skipped} skipped</small></div>
          <div className="rr-h">GitHub first, then the task<span>one row per pull request</span></div>
          <div className="rr-res" role="list">{rows.map((r) => (
            <div key={r.number} className="rr-r" role="listitem"><span className="num">#{r.number}</span><span className="tt">{r.title}</span>
              <div className="cells">{cell(r.gh)}{cell(r.task)}</div></div>
          ))}</div>
        </div>
        <div className="rr-foot">
          <div className="rr-cf"><InfoIcon size={ICON.xs} /><span>{resultLine(rows, sent.items)}</span></div>
          <div className="act"><span className="sp" />
            <Button size="hit" tone={c.failed ? "plain" : "primary"} disabled={c.busy > 0} onClick={close}>Close</Button>
            {c.failed > 0 && <Button size="hit" tone="primary" disabled={c.busy > 0} onClick={() => go(sent.items, sent.who, again)} data-bulk-ask-retry>Retry failed ({c.failed})</Button>}
          </div>
        </div>
      </div>
    );
  })();

  const footer = (
    <div className="rr-foot">
      <div className="rr-sum" role="status">{summary ? <><span className="ok"><DoneIcon size={ICON.xs} /></span><span>{summary}</span></> : <span style={{ color: "var(--text4)" }}>Pick a reviewer</span>}</div>
      {summary && <div className="rr-cf"><InfoIcon size={ICON.xs} /><span>Writes to {writesTo(items)} cannot be undone from here. Nothing is written until you press the button.</span></div>}
      <div className="act"><span className="sp" /><Button size="hit" onClick={() => onOpen(false)}>Cancel</Button>
        <Button size="hit" tone="primary" disabled={!canSend(items, who)} onClick={apply} data-bulk-ask-apply>Request review on {n}</Button></div>
    </div>
  );

  return (
    <span className="relative flex" ref={box}>
      <Button size="hit" tone={open ? "primary" : "plain"} aria-haspopup="dialog" aria-expanded={open} buttonRef={btn} onClick={() => (busy ? undefined : out ? close() : onOpen(!open))} data-bulk-ask>
        <UserPlusIcon size={ICON.sm} />Request review…
      </Button>
      {open && (results ?? (
        <PeoplePicker title="Request a review" hint={`${n} pull request${n === 1 ? "" : "s"} · one person for all ${n}`} mode="reviewers"
          view={view} query={query} onQuery={setQuery} load={load} onRetry={readUsers} repo={repo}
          onToggle={(row: AskRow) => { setWho((w) => (w === row.id ? null : row.id)); setQuery(""); }}
          onRemoveChip={() => setWho(null)} onPopChip={() => setWho(null)}
          onDone={apply} onClose={() => onOpen(false)} trigger={btn} anchor={btn.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0)} panelBox={null}
          footer={footer}>
          {skipNote && <div className="rr-skip"><InfoIcon size={ICON.xs} /><span>{skipNote}</span></div>}
          {withTask.length > 0 && <>
            <div className="rr-h">Also on the linked tasks<span>{withTask.length} of {n} have a linked task</span></div>
            {kinds.map(toolBlock)}
            {noTask.length > 0 && <div className="rr-none"><LinkIcon size={ICON.xs} /><span>{noTask.map((x) => `#${x.number}`).join(", ")} {noTask.length === 1 ? "has" : "have"} no linked task. Only GitHub changes there.</span></div>}
          </>}
        </PeoplePicker>
      ))}
    </span>
  );
}
