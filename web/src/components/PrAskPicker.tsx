/*
 * "Request a review", "Assign" and "Hand over to": one popover, one Done.
 *
 * The people half is the shared PeoplePicker, fed by lib/prAskWho.ts. The card
 * half ("On the card") is the other half of the same errand: who the tracker
 * card is assigned to and which status it moves to. One press of Done applies
 * both through the plan in lib/prHandOver.ts, each against its own system, and
 * the answer comes back as one row per system (lib/prApplyResult.ts) so GitHub
 * can pass while the card fails and only the failed one is sent again.
 *
 * Nothing here has a network call of its own that the old picker did not have:
 * GitHub goes through the panel's `deps` (the same optimistic writes and the
 * same endpoints), the card through `api.clickupCard` or the Jira tracker seam,
 * and an extra comment or field through `sendExtras`.
 *
 * Every hook runs before anything may return: the tracker setup arrives a
 * render late, and a component whose hook count changes takes the window with it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { PrDetail } from "../../../shared/types.ts";
import { PeoplePicker, type PickerLoad } from "./workspace/PeoplePicker.tsx";
import { Button, CTRL_H, EDGE, INPUT, INPUT_STYLE, LINE } from "./workspace/Chrome.tsx";
import { AssignPicker, Face, useAskAssign } from "./AssignPicker.tsx";
import { AskedExtras, sendExtras } from "./AskedExtras.tsx";
import { ICON } from "../lib/iconSize.ts";
import { DoneIcon, FlagIcon, LinkIcon, LockIcon, SearchIcon, UndoIcon, WarningIcon, CrossIcon, CheckboxIcon } from "../lib/glyphIcons.tsx";
import { askView, togglePick, type AskMode, type AskRow } from "../lib/prAskWho.ts";
import { askSource } from "../lib/prPeopleSource.ts";
import { handOverPlan, nextStatuses, statusTone, type StatusTone, type StepId, type TrackerKind } from "../lib/prHandOver.ts";
import { applyResult, startSteps, type Outcome, type Outcomes } from "../lib/prApplyResult.ts";
import { runSteps, type Runner } from "../lib/prApplyRun.ts";
import { cardSuggestions, mirrorLinked, readLinks, withLink, writeLinks, type CardMember } from "../lib/prCardPeople.ts";
import { loadUse, recordPicks } from "../lib/personUsage.ts";
import { reviewerRoster } from "../lib/prReviewers.ts";
import { ownersOf } from "../lib/codeowners.ts";
import { cardOf, onCard, putCard } from "../lib/prCardStore.ts";
import { reviewStatus, mergeCardRefOrRow } from "../lib/cardMove.ts";
import { cardWriteBlock } from "../lib/cardWrites.ts";
import { useJiraSettings } from "../lib/jiraSettings.ts";
import { useClickupPrefs } from "../lib/clickupPrefs.ts";
import { listMembers } from "../lib/listMembers.ts";
import { authorOf, ensureIds, resolveEnsure } from "../lib/stepAssign.ts";
import { hasExtras, planOf, touchesPeople } from "../../../shared/stepBlocks.ts";
import { prContext, type ExtraItem } from "../lib/stepExtras.ts";
import { TRACKERS, type StatusOption } from "../lib/trackerApi.ts";
import { PEOPLE_WAIT_MS } from "../lib/trackerPeople.ts";
import type { ClickUpSetup } from "../lib/clickupSetup.ts";
import type { RefSetup } from "../lib/cardRef.ts";
import type { CardWriteResult } from "../lib/trackerPeople.ts";
import type { StatusWriteResult } from "../lib/trackerStatus.ts";
import type { ClickUpStepBlock as StepBlock, ListField, ListMember, ListStatus, ProviderTask } from "../../../shared/providers.ts";

/** What the panel hands over: the picker sends nothing to GitHub by itself. */
export interface AskDeps {
  /** Request (reviewers) or assign (assignees) these on GitHub; true when GitHub took it. Teams arrive as `org/team`. */
  sendGithub: (mode: AskMode, add: string[]) => Promise<boolean>;
  /** Ask somebody who has already answered again. */
  rerequest: (login: string) => Promise<boolean>;
  /** Take a pending reviewer, or an assignee, off. */
  remove: (mode: AskMode, login: string) => Promise<boolean>;
  /** The panel's toast, for the line a finished apply leaves behind. */
  note: (ok: boolean, msg: string) => void;
}

export interface AskSourceData {
  /** `null` until read. */
  users: string[] | null;
  assignable: string[] | null;
  owners: { rules: { pattern: string; owners: string[] }[] };
  load: PickerLoad;
  retry: () => void;
}

type Setup = (ClickUpSetup & Pick<RefSetup, "ownerOf" | "jira">) | null;

/** A person as the card's tracker knows them. */
export interface CardPerson extends CardMember {
  id: number | string;
  email?: string;
  /** The connected account. */
  me?: boolean;
  avatar?: string;
  initials?: string;
  color?: string;
  /** Why this one cannot be taken off. */
  lock?: string;
}

const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0]!.toUpperCase()).join("") || "?";
const fromMember = (m: ListMember): CardPerson => ({
  id: m.id, key: String(m.id), ident: String(m.id), name: m.name, ...(m.email ? { email: m.email } : null),
  ...(m.avatar ? { avatar: m.avatar } : null), initials: m.initials, ...(m.color ? { color: m.color } : null), ...(m.me ? { me: true } : null),
});
/** A person as a link stored them: what was confirmed, drawn the way the card half draws anyone. */
const fromLink = (m: CardMember): CardPerson => ({ id: m.key, key: m.key, ident: m.ident, name: m.name, initials: initialsOf(m.name) });

export type CardState = "unknown" | "none" | "unlinked" | "reading" | "missing" | "ready";

export interface CardSide {
  state: CardState;
  kind: TrackerKind | null;
  /** `ORBIT-1042`. */
  label: string;
  query: string;
  /** The sentence for a tracker that cannot be written to, or null. */
  blocked: string | null;
  task: ProviderTask | null;
  error: string;
  /** The tracker's statuses in its own order. */
  chain: string[];
  /** Jira's moves from where the card is now. */
  options: StatusOption[] | null;
  roster: CardPerson[] | null;
  onCard: CardPerson[];
  /** What Settings says a review does to the card, applied until the person chooses. */
  defaults: { status: string; mirror: boolean };
  /** Who the review step puts on the card; when the step also moves it, only if the status really moves. */
  ensured: CardPerson[];
  moveOn: boolean;
  askedAssign: ReturnType<typeof useAskAssign> | null;
  extras: { blocks: readonly StepBlock[]; fields: ListField[] | null } | null;
  setExtras: (i: ExtraItem[]) => void;
  extraItems: ExtraItem[];
  /** The card as it stands now (a write moves its stamp). */
  current: () => ProviderTask | null;
  advance: (t: ProviderTask | undefined) => void;
}

export function usePrCardSide(o: { d: PrDetail; setup: Setup; on: boolean }): CardSide {
  const { d, setup } = o;
  const jiraSettings = useJiraSettings();
  const ref = useMemo(() => mergeCardRefOrRow(d, setup), [d.headRefName, d.title, d.body, d.card, setup]); // eslint-disable-line react-hooks/exhaustive-deps
  const kind: TrackerKind | null = ref ? (ref.tracker === "jira" ? "jira" : "clickup") : null;
  const blocked = cardWriteBlock(kind, setup, jiraSettings);
  const query = ref?.query ?? "";
  const [, redraw] = useState(0);
  useEffect(() => onCard(() => redraw((n) => n + 1)), []);
  const hit = o.on && ref ? cardOf(ref.query, undefined, kind ?? "clickup") : null;
  const task = hit?.task ?? null;
  const taskRef = useRef<ProviderTask | null>(task);
  if (task && (!taskRef.current || taskRef.current.id !== task.id || (task.updated ?? 0) >= (taskRef.current.updated ?? 0))) taskRef.current = task;

  const [meta, setMeta] = useState<{ statuses: ListStatus[]; fields: ListField[] | null; members: ListMember[] | null }>({ statuses: [], fields: null, members: null });
  const [options, setOptions] = useState<StatusOption[] | null>(null);
  const listId = task?.listId;
  useEffect(() => {
    if (!o.on || kind !== "clickup" || !listId) return;
    let live = true;
    void Promise.all([api.clickupList(listId).catch(() => null), listMembers(listId).catch(() => null)]).then(([m, mem]) => {
      if (live) setMeta({ statuses: m?.ok ? (m.statuses ?? []) : [], fields: m?.ok ? (m.fields ?? []) : [], members: mem?.ok ? (mem.members ?? []) : [] });
    });
    return () => { live = false; };
  }, [o.on, kind, listId]);
  const taskId = task?.id, taskStatus = task?.status;
  useEffect(() => {
    if (!o.on || kind !== "jira" || !task) return;
    let live = true;
    void TRACKERS.jira.statusOptions(task).then((r) => { if (live) setOptions(r.ok ? (r.data ?? []) : []); }).catch(() => { if (live) setOptions([]); });
    return () => { live = false; };
  }, [o.on, kind, taskId, taskStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  /* What the team's own review step says (Settings): ClickUp only, and off until it is turned on. */
  const reviewPrefs = useClickupPrefs()?.review;
  const menuPlan = reviewPrefs && kind === "clickup" ? planOf("menu", reviewPrefs) : null;
  const stepOn = reviewPrefs?.enabled === true && !!menuPlan && (!!menuPlan.move || touchesPeople(menuPlan) || hasExtras(menuPlan));
  const moveOn = stepOn && !!menuPlan?.move;
  const assignReviewer = kind === "clickup" && reviewPrefs?.assignReviewer === true;
  const author = useMemo(() => authorOf(d), [d.author, d.authorName, d.authorEmail]); // eslint-disable-line react-hooks/exhaustive-deps
  const members = meta.members;
  const fixedEnsure = useMemo(() => (members === null ? ({ kind: "none" } as const) : resolveEnsure(menuPlan?.assign, { author, members })), [menuPlan?.assign, author, members]);
  const askAssign = stepOn ? (menuPlan?.askAssign ?? null) : null;
  const asked = useAskAssign({ on: !!askAssign, members, ...(askAssign ? { start: askAssign } : null), author, onCard: (task?.people ?? []).map((p) => ({ id: p.id ?? null })) });
  const ensure = askAssign ? asked.ensure : fixedEnsure;
  const [extraItems, setExtras] = useState<ExtraItem[]>([]);

  const roster = useMemo(() => (members ? members.map(fromMember) : null), [members]);
  const onCardPeople = useMemo<CardPerson[]>(() => (task?.people ?? []).map((p) => {
    const ident = kind === "jira" ? (p.key ?? "") : String(p.id ?? "");
    return { id: ident, key: ident, ident, name: p.name, ...(p.avatar ? { avatar: p.avatar } : null), initials: p.initials, ...(p.color ? { color: p.color } : null) };
  }), [task?.people, kind]);
  const ensured = useMemo<CardPerson[]>(() => {
    if (!stepOn) return [];
    const ids = new Set(ensureIds(ensure, members));
    return (roster ?? []).filter((r) => ids.has(Number(r.id))).map((r) => ({ ...r, lock: "Put on the card by the review step’s “Also assign” setting" }));
  }, [ensure, members, roster, moveOn, stepOn, menuPlan]);

  const chain = kind === "jira" ? (options ?? []).map((x) => x.toStatus) : meta.statuses.map((s) => s.status);
  const status = task?.status ?? "";
  const names = menuPlan?.move?.names ?? [];
  const preferred = !blocked && moveOn && (names.length > 0 || menuPlan?.move?.fallback) ? reviewStatus(meta.statuses, status, names) : "";

  let state: CardState = "unknown";
  if (setup) {
    if (!setup.connected && !setup.jira) state = "none";
    else if (!ref || !kind) state = "unlinked";
    else if (!task) state = hit?.error ? "missing" : "reading";
    else state = "ready";
  }
  return {
    state, kind, label: ref?.label ?? "", query, blocked, task, error: hit?.error ?? "", chain, options, roster, onCard: onCardPeople,
    defaults: { status: preferred, mirror: assignReviewer }, ensured, moveOn, askedAssign: askAssign ? asked : null,
    extras: stepOn && menuPlan && hasExtras(menuPlan) ? { blocks: reviewPrefs!.blocks ?? [], fields: meta.fields } : null,
    setExtras, extraItems, current: () => taskRef.current,
    advance: (t) => { if (t) { taskRef.current = t; putCard(query, t); } },
  };
}

/** Jira finds people by what is typed, not from a roster. Nobody is looked up for a login: only what the person types. */
function useJiraFinds(side: CardSide, on: boolean): { search: (q: string) => void; found: CardPerson[] } {
  const [found, setFound] = useState<CardPerson[]>([]);
  const task = side.task;
  const toPerson = (p: { id: string; key: string; name: string; avatar?: string }): CardPerson => ({ id: p.id, key: p.key, ident: p.id, name: p.name, initials: initialsOf(p.name), ...(p.avatar ? { avatar: p.avatar } : null) });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const search = useCallback((q: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (!on || side.kind !== "jira" || !task || !q.trim()) { setFound([]); return; }
    timer.current = setTimeout(() => {
      void TRACKERS.jira.people!(task, q).then((r) => setFound(r.ok ? (r.data ?? []).map(toPerson) : [])).catch(() => setFound([]));
    }, PEOPLE_WAIT_MS);
  }, [on, side.kind, task]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { search, found };
}

const TONE_INK: Record<StatusTone, string> = { done: "var(--success)", review: "var(--info)", progress: "var(--warning)", plain: "var(--text3)" };

/** A status as the card half draws it: tone by meaning, ClickUp round with a dot, Jira square. */
function CardStatus({ status, kind }: { status: string; kind: TrackerKind | null }) {
  const ink = TONE_INK[statusTone(status)];
  return (
    <span className="inline-flex items-center gap-1 px-2 text-[11px] font-medium" title={status}
      style={{ height: 20, borderRadius: kind === "jira" ? 6 : 10, color: ink, background: `color-mix(in srgb, ${ink} 13%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${ink} 30%, transparent)` }}>
      {kind !== "jira" && <i aria-hidden className="rounded-full" style={{ width: 6, height: 6, background: ink }} />}
      {status}
    </span>
  );
}

const sys = (k: TrackerKind | null) => (k === "jira" ? "Jira" : "ClickUp");
const UNREACHABLE = "Could not reach the server";
const said = (error: string | undefined): Outcome => ({ state: "fail", ...(error && error !== UNREACHABLE ? { error } : null) });

export function PrAskPicker({ d, repo, anchor, mode: startMode, handOver, source, setup, deps, onClose }: {
  d: PrDetail; repo: string; anchor: DOMRect; mode: AskMode; handOver?: boolean;
  source: AskSourceData; setup: Setup; deps: AskDeps; onClose: () => void;
}) {
  const [mode, setMode] = useState<AskMode>(handOver ? "reviewers" : startMode);
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const side = usePrCardSide({ d, setup, on: true });
  const [mirrorSet, setMirrorSet] = useState<boolean | null>(null);
  const [own, setOwn] = useState<string[]>([]);
  const [q2, setQ2] = useState("");
  const [statusSet, setStatusSet] = useState<string | null | undefined>(undefined);
  const [out, setOut] = useState<Outcomes>({});
  const jira = useJiraFinds(side, side.state === "ready" && side.kind === "jira");
  /* The logins the person confirmed as tracker people, per tracker; nothing is matched by name or email. */
  const [linksTick, setLinksTick] = useState(0);
  const links = useMemo(() => (side.kind ? readLinks(side.kind) : {}), [side.kind, linksTick]);
  const [linking, setLinking] = useState<string | null>(null);

  const readOnly = !!side.blocked;
  const reviewing = mode === "reviewers" || !!handOver;
  const roster = useMemo(() => reviewerRoster(d), [d]);
  const lastCommitAt = d.commits.length ? d.commits[d.commits.length - 1]!.committedAt : undefined;
  const src = useMemo(() => askSource({
    mode, author: d.author, roster, ...(lastCommitAt ? { lastCommitAt } : null),
    users: source.users ?? [], assignable: source.assignable ?? [], assigned: d.assignees,
    owners: ownersOf(source.owners.rules, d.files.map((f: { path: string }) => f.path)), use: loadUse(),
  }), [mode, d, roster, lastCommitAt, source.users, source.assignable, source.owners]);
  const view = useMemo(() => askView({
    mode, author: d.author, viewerDidAuthor: !!d.viewerDidAuthor, repo, people: src.people, teams: src.teams, asked: src.asked,
    assigned: src.assigned, suggested: src.suggested, picked, query,
  }), [mode, d.author, d.viewerDidAuthor, repo, src, picked, query]);

  /* The status: what the person chose, else what Settings says (a hand-over: the review state). */
  const now = side.task?.status ?? "";
  const next = useMemo(() => {
    if (side.state !== "ready" || !side.kind) return [] as string[];
    const base = side.kind === "jira"
      ? nextStatuses("jira", now, (side.options ?? []).filter((x) => !x.needs?.length).map((x) => x.toStatus))
      : nextStatuses("clickup", now, side.chain.length ? side.chain : undefined);
    const pref = side.defaults.status;
    return (pref && !base.includes(pref) ? [pref, ...base] : base).slice(0, 3);
  }, [side.state, side.kind, now, side.chain, side.options, side.defaults.status]);
  const fallbackStatus = side.defaults.status || (handOver ? next[0] ?? "" : "");
  const statusPick = readOnly ? "" : statusSet === undefined ? fallbackStatus : statusSet ?? "";

  /* The card's people: the picker's logins that were linked to a tracker person, or the person's own list. */
  const mirror = mirrorSet ?? (handOver ? true : side.defaults.mirror);
  const trackerRoster = side.kind === "jira" ? null : side.roster;
  const mirrored = useMemo(() => mirrorLinked(picked, links, trackerRoster, fromLink), [picked, links, trackerRoster]);
  const linkRows = useMemo(() => picked.filter((l) => !l.startsWith("@")).map((login) => {
    const one = mirrorLinked([login], links, trackerRoster, fromLink);
    return { login, member: one.matched[0]?.member ?? null, stale: one.unlinked[0]?.stale ?? false };
  }), [picked, links, trackerRoster]);
  const setLink = (login: string, person: CardPerson | null) => {
    if (!side.kind) return;
    writeLinks(side.kind, withLink(links, login, person));
    setLinksTick((n) => n + 1);
  };
  /* The review step adds nobody when it is also meant to move the card and the status is left where it is. */
  const ensuredNow = side.moveOn && !(statusPick && statusPick !== now) ? [] : side.ensured;
  const pool = useMemo(() => {
    const m = new Map<string, CardPerson>();
    for (const p of [...(side.roster ?? []), ...jira.found, ...mirrored.matched.map((x) => x.member), ...side.onCard, ...ensuredNow]) m.set(p.key, m.get(p.key) ?? p);
    return m;
  }, [side.roster, jira.found, side.onCard, ensuredNow, mirrored]);
  const chosen: CardPerson[] = useMemo(() => {
    const base = mirror ? mirrored.matched.map((x) => x.member as CardPerson) : own.flatMap((k) => (pool.get(k) ? [pool.get(k)!] : []));
    const ids = new Set(base.map((p) => p.key));
    const all = [...base, ...ensuredNow.filter((p) => !ids.has(p.key))];
    return side.kind === "jira" ? all.slice(0, 1) : all;
  }, [mirror, mirrored, own, pool, ensuredNow, side.kind]);
  const onCardIdent = new Set(side.onCard.map((p) => p.ident));
  const toAdd = chosen.filter((p) => !onCardIdent.has(p.ident));
  /* Who stays on the card when nobody is chosen: the card's own people, never the pull request's author (a GitHub login is nobody on a tracker). */
  const staying = !chosen.length && !handOver ? side.onCard : [];
  const dropPeople = handOver ? side.onCard.filter((p) => !chosen.some((c) => c.ident === p.ident)) : [];

  const extraLines = side.extraItems.map((i) => (i.kind === "comment" ? "comment on the card" : `set ${i.name} to ${i.shown}`));
  const plan = useMemo(() => handOverPlan({
    mode, ...(handOver ? { handOver: true } : null), author: d.author, picked,
    already: reviewing ? src.asked.map((a) => a.login) : d.assignees,
    tracker: {
      kind: side.state === "none" || side.state === "unknown" ? null : side.kind ?? (setup?.connected ? "clickup" : "jira"),
      ...(side.label ? { card: side.label } : null),
      ...(readOnly ? { readOnly: true } : null), ...(now ? { status: now } : null),
    },
    card: { mirror: false, people: toAdd.map((p) => p.name), status: statusPick || null, ...(dropPeople.length ? { drop: dropPeople.map((p) => p.name) } : null), ...(extraLines.length ? { extras: extraLines } : null) },
  }), [mode, handOver, d.author, d.assignees, picked, reviewing, src.asked, side.state, side.kind, side.label, readOnly, now, toAdd, statusPick, dropPeople, extraLines.join("|"), setup]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(() => applyResult(plan, out), [plan, out]);

  /* ---- sending ---- */
  const live = useRef({ plan, side, toAdd, dropPeople, statusPick, mode, reviewing, picked, jira });
  live.current = { plan, side, toAdd, dropPeople, statusPick, mode, reviewing, picked, jira };

  const github: Runner = async (steps) => {
    const s = steps[0]!;
    const add = [...(s.add ?? []), ...(s.teams ?? []).map((t) => t.replace(/^@/, ""))];
    const ok = await deps.sendGithub(s.id === "gh-assignees" ? "assignees" : "reviewers", add);
    if (ok) recordPicks(s.add ?? []);
    return { [s.id]: ok ? { state: "ok" } : { state: "fail" } } as Outcomes;
  };
  const cardRunner: Runner = async (steps) => {
    const { side: sd, toAdd: add, dropPeople: drop, statusPick: to } = live.current;
    const task0 = sd.current();
    const res: Outcomes = {};
    if (!task0) { for (const s of steps) res[s.id] = { state: "fail" }; return res; }
    const has = (id: StepId) => steps.some((s) => s.id === id);
    let good = true;
    if (sd.kind === "clickup") {
      if (has("card-assign") || has("card-status")) {
        const r = await api.clickupCard(task0.id, {
          ...(has("card-assign") && add.length ? { add: add.map((p) => Number(p.key)) } : null),
          ...(has("card-assign") && drop.length ? { rem: drop.map((p) => Number(p.key)) } : null),
          ...(has("card-status") && to ? { status: to } : null),
        }, task0.updated).catch(() => ({ ok: false as const, error: UNREACHABLE, task: undefined }));
        if (r.ok) sd.advance(r.task);
        else good = false;
        for (const id of ["card-assign", "card-status"] as const) if (has(id)) res[id] = r.ok ? { state: "ok" } : said(r.error);
      }
    } else if (sd.kind === "jira") {
      let task = task0;
      if (has("card-assign")) {
        const r = await TRACKERS.jira.setPeople!(task, { set: add[0]?.key ?? null }).catch(() => ({ ok: false, error: UNREACHABLE } as CardWriteResult));
        if (r.ok) { if (r.task) { task = r.task; sd.advance(r.task); } res["card-assign"] = { state: "ok" }; }
        else { good = false; res["card-assign"] = said(r.conflict ? "somebody changed this card while you had it open" : r.error); }
      }
      if (has("card-status")) {
        const opt = (sd.options ?? []).find((x) => x.toStatus === to);
        if (!opt) { good = false; res["card-status"] = said(`${to} is not a move this card can make from here`); }
        else {
          const r = await TRACKERS.jira.setStatus(task, opt).catch(() => ({ ok: false, error: UNREACHABLE } as StatusWriteResult));
          if (r.ok) { if (r.task) sd.advance(r.task); res["card-status"] = { state: "ok" }; }
          else { good = false; res["card-status"] = said(r.conflict ? "somebody changed this card while you had it open" : r.error); }
        }
      }
    }
    if (has("card-extras")) {
      if (!good) res["card-extras"] = { state: "fail" };
      else {
        const ex = await sendExtras(task0.id, sd.extraItems).catch(() => null);
        res["card-extras"] = ex?.ok ? { state: "ok" } : said(ex?.error);
      }
    }
    return res;
  };

  const run = (ids: StepId[]) => {
    setOut((o) => startSteps(o, ids));
    void runSteps(plan.steps, ids, { github, ...(side.kind ? { [side.kind]: cardRunner } : null) }, (o) => setOut((prev) => ({ ...prev, ...o })));
  };
  const done = () => { if (!plan.done.disabled && result.phase === "idle") run(plan.steps.map((s) => s.id)); };

  /* When everything went through: say so, then close after the beat the result keeps. */
  useEffect(() => {
    if (result.closeAfterMs === null) return;
    const t = setTimeout(() => { deps.note(true, result.toast ?? ""); onClose(); }, result.closeAfterMs);
    return () => clearTimeout(t);
  }, [result.closeAfterMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const locked = result.locked;
  const toggle = (row: AskRow) => setPicked((p) => togglePick(p, row));
  const title = handOver ? "Hand over to" : mode === "reviewers" ? "Request a review" : "Assign";
  const hint = handOver ? "Asks for a review, assigns the card and moves it, in one step." : undefined;

  /* ---- the card half ---- */
  const mirrorLabel = mirror ? `Same people as ${mode}` : `Mirror ${mode} again`;
  const editCard = (keys: string[]) => { setOwn(keys); setMirrorSet(false); };
  const chosenKeys = chosen.filter((p) => !p.lock).map((p) => p.key);
  const [q2Focus, setQ2Focus] = useState(false);
  const cand = useMemo(() => cardSuggestions<CardPerson>({
    q: q2, onCard: side.onCard, roster: side.kind === "jira" ? null : side.roster, found: jira.found,
    skip: linking ? [] : chosen.map((c) => c.key), limit: q2.trim() ? 4 : 6,
  }), [q2, side.onCard, side.kind, side.roster, jira.found, chosen, linking]);
  const pickCand = (p: CardPerson) => {
    if (linking) { setLink(linking, p); if (!mirror) setOwn([...chosenKeys.filter((k) => k !== p.key), p.key]); setLinking(null); }
    else editCard([...chosenKeys, p.key]);
    setQ2("");
  };

  const statusOptions = [{ id: "", label: "Leave it" }, ...next.map((s) => ({ id: s, label: s }))];
  const cardBlock = (() => {
    switch (side.state) {
      case "unknown": return null;
      case "none": return (
        <div className="flex items-start gap-1.5 text-[11.5px]" style={{ color: "var(--text4)" }}>
          <span className="mt-0.5 shrink-0"><LinkIcon size={ICON.xs} /></span>
          <span>No tracker is connected for this repo, so no card is updated here. Connect one in Settings.</span>
        </div>);
      case "unlinked": return (
        <>
          <b className="text-[12px]" style={{ color: "var(--text)" }}>On the card</b>
          <div className="flex items-start gap-2 text-[12px]">
            <span className="mt-0.5 shrink-0"><LinkIcon size={ICON.sm} /></span>
            <div><b>No card is linked to #{d.number}</b><div className="text-[11.5px]" style={{ color: "var(--text3)" }}>Link one and this step can assign and move it too.</div></div>
          </div>
        </>);
      case "reading": case "missing": return (
        <>
          <b className="text-[12px]" style={{ color: "var(--text)" }}>On the card · {side.label}</b>
          <span className="text-[11.5px]" style={{ color: side.state === "missing" ? "var(--warning-ink)" : "var(--text3)" }}>
            {side.state === "reading" ? "Reading the card…" : side.error || `${sys(side.kind)} could not find it`}
          </span>
        </>);
      case "ready": return (
        <div className="grid gap-1.5 min-w-0" style={{ gridTemplateColumns: "minmax(0, 1fr)" }} aria-disabled={readOnly || undefined}>
          <div className="inline-flex items-center gap-1.5 text-[11px] rounded-lg self-start" style={{ background: "var(--surface-inset)", padding: "4px 8px" }}>
            <span style={{ color: side.kind === "jira" ? "var(--info)" : "var(--primary)" }}>{side.kind === "jira" ? <FlagIcon size={ICON.xs} /> : <CheckboxIcon size={ICON.xs} />}</span>
            <b>On the card</b><span style={{ color: "var(--text3)" }}>· {side.label}</span>
          </div>
          <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--text4)" }}>
            <span>Status now</span><span className="ml-auto normal-case tracking-normal font-normal"><CardStatus status={now} kind={side.kind} /></span>
          </div>
          {readOnly && (
            <div className="flex items-start gap-1.5 text-[11.5px] rounded-lg p-2" role="status" style={{ border: EDGE, background: "color-mix(in srgb, var(--info) 8%, transparent)", color: "var(--text2)" }}>
              <span className="mt-0.5 shrink-0" style={{ color: "var(--info)" }}><LockIcon size={ICON.xs} /></span>
              <span><b>{sys(side.kind)} is read-only for this token.</b> The card will not change. Do it by hand after. <span style={{ color: "var(--text3)" }}>{side.blocked}</span></span>
            </div>)}
          <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--text4)" }}>
            <span>Assign on the card</span>
            {linkRows.some((r) => r.member) && <button type="button" aria-pressed={mirror} disabled={readOnly || locked}
              onClick={() => { if (mirror) { setOwn(mirrored.matched.map((x) => x.member.key as string)); setMirrorSet(false); } else setMirrorSet(true); }}
              className="ml-auto inline-flex items-center gap-1 px-2 rounded-full normal-case tracking-normal text-[11px] font-medium disabled:opacity-50"
              style={{ height: CTRL_H.compact, border: EDGE, color: mirror ? "var(--primary)" : "var(--text2)", background: mirror ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "transparent" }}>
              {mirror ? <DoneIcon size={ICON.xs} /> : <UndoIcon size={ICON.xs} />}{mirrorLabel}
            </button>}
          </div>
          <div className="flex flex-wrap items-center gap-1" style={{ opacity: readOnly ? 0.5 : 1 }}>
            {chosen.map((p) => (
              <span key={p.key} className="inline-flex items-center gap-1 pl-1 pr-0.5 text-[11.5px] font-medium rounded-full" title={p.lock}
                style={{ height: 24, background: "var(--surface-inset)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 14%, transparent)" }}>
                <Face m={p} size={16} />{p.name}
                {!p.lock && !readOnly && <button type="button" aria-label={`Remove ${p.name} from the card`} disabled={locked} onClick={() => editCard(chosenKeys.filter((k) => k !== p.key))}
                  className="inline-flex items-center justify-center rounded-full" style={{ width: 16, height: 16, color: "var(--text3)" }}><CrossIcon size={ICON.xs} /></button>}
              </span>))}
            {staying.map((p) => (
              <span key={p.key} className="inline-flex items-center gap-1 pl-1 pr-2 text-[11.5px] rounded-full" style={{ height: 24, color: "var(--text3)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 14%, transparent)" }}>
                <Face m={p} size={16} />{p.name}
              </span>))}
            {staying.length > 0 && <span className="text-[11.5px]" style={{ color: "var(--text4)" }}>{staying.length === 1 ? "stays" : "stay"} on the card</span>}
            {!chosen.length && !staying.length && <span className="text-[11.5px]" style={{ color: "var(--text4)" }}>Nobody chosen for the card</span>}
          </div>
          {linkRows.length > 0 && (
            <div className="grid gap-0.5" role="group" aria-label={`${sys(side.kind)} people for the ${mode}`}>
              {linkRows.map((r) => (
                <div key={r.login} className="flex items-center gap-1.5 text-[11px] min-w-0" style={{ color: r.member ? "var(--text2)" : "var(--text3)" }}>
                  <span className="truncate"><b style={{ color: "var(--text)", fontWeight: 600 }}>{r.login}</b>{r.member ? <> is <b style={{ color: "var(--text)", fontWeight: 600 }}>{r.member.name}</b> on {sys(side.kind)}</> : r.stale ? <> was linked to someone who is no longer on {sys(side.kind)}</> : <> is not linked to a {sys(side.kind)} person</>}</span>
                  <span className="ml-auto flex items-center gap-1 shrink-0">
                    <Button size="compact" disabled={readOnly || locked} onClick={() => { setLinking(r.login); setQ2(""); }}>{r.member ? `Change` : `Link ${r.login} to…`}</Button>
                    {r.member && <Button size="compact" disabled={readOnly || locked} onClick={() => setLink(r.login, null)} title={`Forget that ${r.login} is ${r.member.name}`}>Unlink</Button>}
                  </span>
                </div>))}
            </div>)}
          {side.kind === "jira" && mirrored.matched.length + own.length > 1 && (
            <div className="text-[11px]" style={{ color: "var(--text3)" }}>Jira puts one person on a card: {chosen[0]?.name}.</div>)}
          <label className="relative flex items-center" style={{ opacity: readOnly ? 0.5 : 1 }}>
            <span className="absolute left-2 pointer-events-none" style={{ color: "var(--text3)" }}><SearchIcon size={ICON.xs} /></span>
            <input value={q2} disabled={readOnly || locked} onChange={(e) => { setQ2(e.target.value); jira.search(e.target.value); }}
              onFocus={() => setQ2Focus(true)} onBlur={() => setQ2Focus(false)}
              placeholder={linking ? `Link ${linking} to…` : "Add someone to the card"} aria-label={linking ? `Link ${linking} to a ${sys(side.kind)} person` : "Add someone to the card"} autoComplete="off" spellCheck={false}
              className={`w-full ${INPUT}`} style={{ ...INPUT_STYLE, height: 26, fontSize: 11.5, paddingLeft: 28 }} />
          </label>
          {linking && <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text3)" }}>Pick who {linking} is on {sys(side.kind)}. This is remembered.<Button size="compact" className="ml-auto" onClick={() => { setLinking(null); setQ2(""); }}>Cancel</Button></div>}
          {cand.length > 0 && (q2.trim() !== "" || q2Focus || linking) && (
            <div role="listbox" aria-label={`People on ${sys(side.kind)}`} className="rounded-lg p-0.5" style={{ border: EDGE, background: "var(--surface-card)" }}>
              {cand.map(({ person: p, why }) => (
                <button key={p.key} type="button" role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => pickCand(p)}
                  className="agx-mi w-full flex items-center gap-2 px-2 text-left text-[12px] rounded-md" style={{ minHeight: 30 }}>
                  <Face m={p} size={20} /><span className="truncate min-w-0">{p.name}</span>
                  {why && <span className="text-[10.5px] shrink-0" style={{ color: "var(--text4)" }}>{why}</span>}
                  {p.email && <span className="truncate min-w-0 text-[10.5px]" style={{ color: "var(--text3)" }}>{p.email}</span>}
                </button>))}
            </div>)}
          {side.askedAssign && (
            <div className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--text3)" }}>
              <span>Also put on the card</span>
              <AssignPicker state={side.askedAssign} disabled={readOnly || locked} />
            </div>)}
          {side.extras && side.task && (
            <AskedExtras blocks={side.extras.blocks} fields={side.extras.fields} listId={side.task.listId} onChange={side.setExtras}
              ctx={prContext({ pr: { number: d.number, title: d.title, url: d.url }, author: authorOf(d), status: statusPick || now })} />)}
          <div className="text-[10.5px] font-semibold uppercase tracking-wide mt-1" style={{ color: "var(--text4)" }}>Status</div>
          <div role="radiogroup" aria-label="Card status" aria-disabled={readOnly || undefined} className="agx-seg self-start" style={{ opacity: readOnly ? 0.5 : 1 }}>
            {statusOptions.map((o) => (
              <button key={o.id || "leave"} type="button" role="radio" aria-checked={statusPick === o.id} disabled={readOnly || locked}
                onClick={() => setStatusSet(o.id === "" ? null : o.id)}
                className="agx-seg-b disabled:cursor-not-allowed">
                {o.label}
              </button>))}
          </div>
          {statusPick && !readOnly && (
            <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--text3)" }}><CardStatus status={now} kind={side.kind} /><span aria-hidden>→</span><CardStatus status={statusPick} kind={side.kind} /></div>)}
        </div>);
    }
  })();

  const footer = (
    <>
      {result.phase === "idle" ? (
        <div className="flex items-start gap-1.5 text-[11.5px] rounded-lg" style={{ background: "var(--surface-inset)", padding: "6px 8px", color: "var(--text2)", minHeight: 18 }} role="status">
          {plan.empty
            ? <span style={{ color: "var(--text4)" }}>Nothing to apply yet</span>
            : <><span className="mt-0.5 shrink-0" style={{ color: "var(--success)" }}><DoneIcon size={ICON.xs} /></span><span>{plan.summary}</span></>}
        </div>
      ) : (
        <div className="grid gap-1.5" role="status">
          {result.rows.map((r) => (
            <div key={r.system} className="flex items-center gap-2">
              <span className="shrink-0" style={{ color: r.state === "ok" ? "var(--success)" : r.state === "fail" ? "var(--error)" : "var(--text3)" }}>
                {r.state === "ok" ? <DoneIcon size={ICON.sm} /> : r.state === "fail" ? <WarningIcon size={ICON.sm} /> : <span className="agx-spin inline-block" aria-hidden style={{ width: 12, height: 12, borderWidth: 1.5 }} />}
              </span>
              <div className="flex-1 min-w-0 grid">
                <b className="text-[12px] font-semibold">{r.label}</b>
                <small className="text-[11px]" style={{ color: r.state === "fail" ? "var(--error-ink)" : "var(--text3)" }}>{r.text}</small>
              </div>
              {r.retryLabel && <Button size="compact" onClick={() => run(r.retry)}>{r.retryLabel}</Button>}
            </div>))}
        </div>
      )}
      <div className="flex items-center gap-1.5 pt-2" style={{ borderTop: LINE }}>
        <Button size="hit" onClick={onClose}>Cancel</Button>
        <span className="flex-1" />
        <Button size="hit" tone="primary" disabled={result.done.disabled} pending={result.phase === "working"} onClick={done}>{result.done.label}</Button>
      </div>
    </>
  );

  return (
    <PeoplePicker
      title={title} {...(hint ? { hint } : null)} mode={mode} {...(handOver ? null : { onMode: setMode })}
      view={view} query={query} onQuery={setQuery} load={source.load} onRetry={source.retry} repo={repo}
      locked={locked} dismissible={result.phase !== "working"}
      onToggle={toggle} onRemoveChip={(id) => setPicked((p) => p.filter((x) => x !== id))} onPopChip={() => setPicked((p) => p.slice(0, -1))}
      onRerequest={(r) => { void deps.rerequest(r.id); }}
      onRemoveHeld={(r) => { void deps.remove(mode, r.id); }}
      onDone={done} onClose={onClose} anchor={anchor}
      footer={footer}>
      {cardBlock}
    </PeoplePicker>
  );
}
