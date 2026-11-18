/*
 * The head of the card's detail panel, from the mockup: the key and the space it lives in, the title (it wraps), the status pill,
 * the worker chip with what it has cost, and one row of actions that wraps rather than overlapping (a narrow dock used to shrink
 * the primary button to an icon). The primary action is the next step of the lifecycle: "Open live worker" while a worker runs.
 * Send to terminal and the "..." menu open over the panel and close with it; the rest of what the old head held (watch, vote, the
 * flight plan, the hand-off, the move) is still here, nothing was dropped.
 */
import { openExternal } from "../../../lib/externalUrl.ts";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import type { CardFact, ProviderTask, TaskDetail } from "../../../../../shared/providers.ts";
import { api } from "../../../lib/api.ts";
import { jiraBranchName, jiraWorktreeCommand } from "../../../lib/cardBranch.ts";
import { headerMenu, sendMenu } from "../../../lib/cardDetailMenu.ts";
import { usd } from "../../../lib/cardLifecycle.ts";
import { FINISHED_MS } from "../../../lib/jiraCardWork.ts";
import { canEdit, parseTitle, stepFor } from "../../../lib/jiraEdit.ts";
import { projectOf } from "../../../lib/jiraSettings.ts";
import { fmtAgo } from "../../../lib/format.ts";
import { cardBrief } from "../../../lib/cardBrief.ts";
import { sendToTerminal, sentNote } from "../../../lib/sendToTerminal.ts";
import { TRACKERS } from "../../../lib/trackerApi.ts";
import { tipAttr } from "../../../lib/tip.ts";
import { ICON, MIN_BOX } from "../../../lib/iconSize.ts";
import { CaretIcon, ClockIcon, CopyIcon, DoneIcon, LinkIcon, MoreIcon, RefreshIcon } from "../../../lib/glyphIcons.tsx";
import { quietDays } from "../list/model.ts";
import { Button } from "../../workspace/Chrome.tsx";
import { CloseIcon } from "../../CloseButton.tsx";
import { TrackerStatusPick } from "../../TrackerStatusPick.tsx";
import { TrackerHandOffButton } from "../../TrackerHandOffButton.tsx";
import { AskAboutButton } from "../../AskAboutButton.tsx";
import { cardSeed } from "../../../lib/askSeed.ts";
import { peekJiraDev } from "../../../lib/jiraDev.ts";
import { StartFlightPlan } from "../../flightPlan/StartFlightPlan.tsx";
import { EditText } from "../../tasks/CardEdit.tsx";
import { useCopied } from "../../CardChrome.tsx";
import { DockIcon, StateLabel, stateStyle } from "../DockParts.tsx";
import { TypeMark } from "../JiraSections.tsx";
import { isSubtask } from "../list/laneModel.ts";
import { useCardRead } from "./FamilyBlock.tsx";
import { epicOfCard } from "../../../lib/jiraCardScope.ts";
import { askDock } from "../list/menus/dockIntent.ts";
import { JiraVote } from "../JiraFollow.tsx";
import { canPress, followControl } from "../../../lib/jiraFollow.ts";
import { DockChrome, useDockChrome } from "../list/DockChrome.tsx";
import { JiraMenuView } from "../list/menus/JiraMenu.tsx";
import type { JiraEditUi } from "../useJiraEdit.ts";
import type { JiraFollowUi } from "../useJiraFollow.ts";
import { openLive, runNext } from "./cardWorkActions.ts";
import type { CardWork } from "./useCardLifecycle.ts";

/** The line a pick or a send said after it ran: a leading `!` is a warning. */
function Said({ said }: { said: string }) {
  if (!said) return null;
  return <div className="text-[10.5px]" role="status" style={{ color: said.startsWith("!") ? "var(--warning-ink)" : "var(--success-ink)" }}>{said.replace(/^!/, "")}</div>;
}

/** "Orbit / Auth hardening": the space, then the epic the card hangs under when the read names one. */
export function pathOf(t: ProviderTask, facts: readonly CardFact[] | undefined): string {
  const epic = facts?.find((f) => /^(epic|parent)/i.test(f.id))?.value || t.parent?.title || "";
  return [t.list, epic].filter(Boolean).join(" / ");
}

/** The two links of that line: the space (its project key opens it) and the epic (its own key opens its cards). A sub-task has no epic of its own: it shows its parent task's, once that is read. */
export function placeOf(t: ProviderTask, facts: readonly CardFact[] | undefined, parentTask?: ProviderTask | null): { space?: { name: string; key: string }; epic?: { name: string; key: string } } {
  const key = projectOf(t);
  const epic = epicOfCard(t, parentTask);
  const epicName = isSubtask(t) ? epic?.title ?? "" : facts?.find((f) => /^(epic|parent)/i.test(f.id))?.value || t.parent?.title || "";
  const epicKey = epic?.key ?? "";
  return {
    space: t.list && key ? { name: t.list, key } : undefined,
    epic: epicName && epicKey ? { name: epicName, key: epicKey } : undefined,
  };
}

/** One part of the path line: a button that opens that place in the main view, underlined on hover. */
export function PlaceLink({ name, tip, onOpen }: { name: string; tip: string; onOpen?: () => void }) {
  if (!onOpen) return <span>{name}</span>;
  return (
    <button type="button" onClick={onOpen} data-tip={tipAttr({ name, text: tip })} className="agx-btn min-w-0 truncate rounded-md hover:underline" style={{ cursor: "pointer", color: "inherit" }}>
      {name}
    </button>
  );
}

type Open = { which: "more" | "send"; x: number; y: number } | null;

/** A sub-task that does not say where it comes from is a card with no way back. One line, above the key: the
 *  parent's type, key and title, clickable the same way the key below opens the card it names. */
function ParentCrumb({ p, onOpen }: { p: NonNullable<ProviderTask["parent"]>; onOpen?: (key: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen?.(p.key)} disabled={!onOpen}
      className="agx-btn flex items-center min-w-0 max-w-full self-start rounded-md" style={{ gap: 6, fontSize: 11, color: "var(--text3)" }}
      data-tip={tipAttr({ name: p.key, mono: true, text: p.title || "Open the card this one sits under." })}>
      <span className="shrink-0" style={{ fontSize: 10.5, letterSpacing: "0.02em" }}>↳ Sub-task of</span>
      <span className="shrink-0 inline-flex"><TypeMark type={p.type} size={ICON.md} /></span>
      <span className="tabular-nums shrink-0">{p.key}</span>
      {p.title && <span className="min-w-0 truncate">{p.title}</span>}
    </button>
  );
}

export function DetailHeader({ t, writable, onTask, onRefresh, refreshing, ed, follow, nav, onBack, onClose, work, facts, detail, onOpenByKey, onOpenSpace, onOpenEpic, onOpenFollowUp }: {
  t: ProviderTask; writable: boolean; onTask: (t: ProviderTask) => void;
  onRefresh: () => void; refreshing: boolean;
  ed?: JiraEditUi; follow?: JiraFollowUi; nav?: ReactNode; onBack?: () => void; onClose?: () => void;
  work: CardWork; facts?: readonly CardFact[];
  /** The card as read in full: its description, criteria, links and sub-tasks go into the brief a worker gets. */
  detail?: TaskDetail | null;
  /** Opens the parent named by the breadcrumb, or by the Parent field, in place. */
  onOpenByKey?: (key: string) => void;
  /** The space / epic in the path line: load that place in the main view; the card stays open. Absent: plain text. */
  onOpenSpace?: (spaceKey: string) => void;
  onOpenEpic?: (epicKey: string) => void;
  /** After the primary action when it is a pull request or a plan, for a caller that wants to know. */
  onOpenFollowUp?: () => void;
}) {
  const key = t.customId ?? t.id;
  const [copied, copy] = useCopied();
  const [said, setSaid] = useState("");
  const [menu, setMenu] = useState<Open>(null);
  useEffect(() => { setSaid(""); setMenu(null); }, [t.id]);
  const done = t.statusKind === "done";
  const editable = !!(writable && ed && canEdit(ed.edit, "summary"));
  const cut = editable ? 0 : t.title.lastIndexOf(" ") + 1;
  /* A sub-task's epic is its parent task's: the same cached read the family block makes. */
  const parentRead = useCardRead(isSubtask(t) ? t.parent?.key ?? null : null);
  const place = placeOf(t, facts, parentRead?.task);
  const path = isSubtask(t) ? [t.list, place.epic?.name].filter(Boolean).join(" / ") : pathOf(t, facts);
  const chrome = useDockChrome();
  const watch = follow ? followControl("watch", follow.follow, { writes: writable, out: follow.busy, denied: follow.denied.watch ?? null, key }) : null;
  const { life, worker, root, sessions } = work;
  const spent = sessions.reduce((n, s) => n + s.cost, 0);
  /* No live worker: the last session, if it ended inside the board's finished window, so the header says what the tile says. */
  const lastEnded = worker ? null : sessions.filter((s) => !s.live && Date.now() - s.lastSeen <= FINISHED_MS).sort((a, b) => b.lastSeen - a.lastSeen)[0] ?? null;

  const anchor = (which: "more" | "send") => (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ which, x: Math.round(r.left), y: Math.round(r.bottom + 4) });
  };

  const primary = () => { runNext(work, () => { setMenu(null); void send(); }); onOpenFollowUp?.(); };

  const send = async () => {
    if (!root) { setSaid("!No checkout is known for this card"); return; }
    const r = await sendToTerminal(root, cardBrief(t, detail), key);
    const n = sentNote(r, key);
    setSaid(n.ok ? n.text : `!${n.text}`);
  };

  const onPickMore = (id: string) => {
    if (id === "openJira" && t.url) openExternal(t.url);
    else if (id === "copyKey") void copy(key, "id");
    else if (id === "copyLink") void copy(t.url, "url");
    else if (id === "copyBranch") void navigator.clipboard?.writeText(jiraBranchName(key, t.title)).catch(() => undefined);
    else if (id === "reread") onRefresh();
    else if (id === "back") onBack?.();
    else if (id === "watch" && watch) follow?.press("watch", !watch.on);
    else if (id === "placeFloat") chrome?.onMode("float");
    else if (id === "placeBottom") chrome?.onMode("bottom");
  };
  const onPickSend = (id: string) => {
    if (id === "send") void send();
    else if (id === "shell" && root) void api.openShell(root).then((r) => setSaid(r.ok ? "A shell is open in the checkout" : `!No shell opened: ${r.error ?? "unknown"}`)).catch(() => setSaid("!Could not reach agentglass"));
    else if (id === "copyWorktree") void navigator.clipboard?.writeText(jiraWorktreeCommand(key, t.title)).catch(() => undefined);
  };

  const isPrimaryLive = life.next.kind === "open-worker";
  const showPrimary = life.next.kind !== "none" && life.next.label !== "Send to terminal";

  return (
    <div className="agx-jd-head flex flex-col min-w-0" style={{ background: "var(--bg)", padding: "12px 16px 0", gap: 8 }}>
      {isSubtask(t) && t.parent && <ParentCrumb p={t.parent} onOpen={onOpenByKey} />}
      <div className="flex items-center flex-wrap min-w-0" style={{ gap: 6 }}>
        <TypeMark type={t.issueType} size={ICON.xl} />
        <button type="button" onClick={() => void copy(key, "id")} data-tip={tipAttr({ name: key, mono: true, text: "Copy the card id: for a branch, a commit or a colleague." })} aria-label={`Copy ${key}`}
          className="agx-btn tabular-nums rounded-md font-semibold shrink-0" style={{ fontSize: 11.5, color: "var(--info-ink)" }}>
          {copied === "id" ? "copied" : key}
        </button>
        {t.url && (
          <button type="button" data-copy-link onClick={(e) => void copy(e.shiftKey ? `[${key}: ${t.title}](${t.url})` : t.url, "url")} aria-label={copied === "url" ? "Link copied" : "Copy the link"}
            data-tip={tipAttr({ name: copied === "url" ? "Copied" : "Copy the link", text: "The card's Jira address. Shift-click copies it as a Markdown link with its title." })}
            className="agx-btn inline-flex items-center justify-center rounded-md shrink-0" style={{ width: MIN_BOX, height: MIN_BOX, color: copied === "url" ? "var(--success)" : "var(--text4)" }}>
            {copied === "url" ? <DoneIcon size={ICON.sm} /> : <LinkIcon size={ICON.sm} />}
          </button>
        )}
        {path && (
          <span className="agx-jd-path min-w-0 flex items-center order-last basis-full" style={{ gap: 4 }} data-tip={tipAttr({ name: "Where it lives", text: path })}>
            <span className="shrink-0">in</span>
            {place.space ? <PlaceLink name={place.space.name} tip="Show this space in the list." onOpen={onOpenSpace && (() => onOpenSpace(place.space!.key))} /> : null}
            {place.space && place.epic ? <span className="shrink-0">/</span> : null}
            {place.epic ? <PlaceLink name={place.epic.name} tip="Show every card in this epic." onOpen={onOpenEpic && (() => onOpenEpic(place.epic!.key))} /> : null}
            {!place.space && !place.epic ? <span className="truncate">{path}</span> : null}
          </span>
        )}
        <span className="flex-1" />
        {nav}
        {/* One group of equal bordered squares: drag, side panel, pop out, maximise, re-read, close. Re-read is also in the
            "..." menu; it sits here too because it is reached for often enough to want one click. Watch and back stay in the menu. */}
        {(() => {
          const reread = <DockIcon key="reread" label="Re-read the card" tip={{ name: "Re-read the card", text: "Fetch it again from Jira." }} onClick={onRefresh}><RefreshIcon size={ICON.md} className={refreshing ? "agx-turn" : undefined} /></DockIcon>;
          const close = onClose && <DockIcon tip={{ name: "Close", text: "Back to the list.", hint: { key: "Esc", text: "closes the card" } }} onClick={onClose}><CloseIcon size={ICON.md} /></DockIcon>;
          return chrome ? <DockChrome {...chrome}>{reread}{close}</DockChrome> : <span className="agx-jdk-btns" role="group" aria-label="Card">{reread}{close}</span>;
        })()}
      </div>

      <h3 className="min-w-0" data-dock={editable ? "edit" : undefined} style={{ fontFamily: "var(--font-prose)", fontSize: 17, fontWeight: 600, lineHeight: 1.3, letterSpacing: "-0.01em", color: "var(--text)", textWrap: "pretty", overflowWrap: "anywhere" }}>
        {editable
          ? <EditText value={t.title} empty="Untitled" title="Rename this card" wrap textClass="text-[17px] font-semibold leading-snug hover:underline decoration-dotted underline-offset-4" busy={ed!.busy === "summary"}
              parse={parseTitle} onSave={(raw) => { const s = stepFor("summary", { value: raw }, ed!.now); if (s) ed!.run(s); }} />
          : t.title.slice(0, cut)}
        <span style={{ whiteSpace: "nowrap" }}>{editable ? "" : t.title.slice(cut)}
          <button type="button" onClick={() => void copy(t.title, "title")} data-tip={tipAttr({ name: "Copy the title" })} aria-label={copied === "title" ? "Title copied" : "Copy the title"}
            className="inline-flex items-center justify-center align-middle ml-1.5 rounded-md hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)]"
            style={{ width: MIN_BOX, height: MIN_BOX, color: copied === "title" ? "var(--success)" : "var(--text4)" }}>
            {copied === "title" ? <DoneIcon size={ICON.sm} /> : <CopyIcon size={ICON.sm} />}
          </button>
        </span>
      </h3>
      <Said said={follow?.said || said} />

      <div className="agx-jd-row flex items-center flex-wrap min-w-0" style={{ gap: 8 }}>
        {writable
          ? <TrackerStatusPick tracker={TRACKERS.jira} task={t} query={key} onSaid={setSaid} onTask={onTask} chip={26} />
          : <span className="inline-flex items-center shrink-0" data-tip={tipAttr({ name: t.status, text: "Read-only. Turn changes on to move this card." })} style={stateStyle(t.statusColor || undefined, done, 26)}><StateLabel status={t.status} done={done} /></span>}
        {lastEnded && (
          <button type="button" className="agx-jd-worker" data-ended="" onClick={() => askDock(t.id, "work")}
            data-tip={tipAttr({ name: lastEnded.title, detail: "ended", text: `Its last session ended ${new Date(lastEnded.lastSeen).toLocaleTimeString()}; click (or press w) for the Work tab, which has what it did. ${usd(spent)} across the card's sessions.` })}>
            <DoneIcon size={ICON.xs} />
            <span className="min-w-0 truncate">Agent finished {fmtAgo(lastEnded.lastSeen)} ago</span>
          </button>
        )}
        {worker && (
          <button type="button" onClick={() => openLive(null, worker)} className="agx-jd-worker" data-live={worker.status === "working" ? "" : undefined} data-needs={worker.status === "waiting" ? "" : undefined} data-stuck={worker.status === "stalled" || worker.status === "errored" ? "" : undefined}
            data-tip={tipAttr({ name: worker.title, detail: worker.status, text: `${worker.doing ? `Now: ${worker.doing}. ` : ""}${worker.model ?? "model unknown"} · ${usd(worker.cost)} so far${sessions.length > 1 ? `; ${usd(spent)} across the card's ${sessions.length} sessions` : ""}. Click (or press t) to bring its tab forward.` })}>
            <span className="agx-jd-dot" aria-hidden />
            <span className="min-w-0 truncate">{worker.title}</span>
            {/* Waiting is waiting on a person: in words, where the cost would be, the way the board's tile says it. */}
            {worker.status === "waiting" ? <span className="agx-jd-needs">needs you</span> : <span className="agx-jd-cost tabular-nums">{usd(worker.cost)}</span>}
          </button>
        )}
        {t.updated > 0 && (() => {
          const quiet = quietDays(t);
          return <span className="text-[10.5px] inline-flex items-center" style={{ gap: 4, color: quiet ? "var(--warning-ink)" : "var(--text4)" }}
            data-tip={tipAttr({ name: quiet ? `Quiet for ${quiet} days` : "Last change", text: quiet ? `Open, and nothing has changed since ${new Date(t.updated).toLocaleString()}.` : new Date(t.updated).toLocaleString() })}>
            {quiet > 0 && <ClockIcon size={ICON.xs} />}moved {fmtAgo(t.updated)} ago</span>;
        })()}
        <span className="flex-1" />
        <DockIcon tip={{ name: "More", text: "Open in Jira, copy the key, the link or the branch." }} onClick={anchor("more")}><MoreIcon size={ICON.md} /></DockIcon>
      </div>

      <div className="agx-jd-actions flex items-center flex-wrap min-w-0" style={{ gap: 8 }}>
        {showPrimary && (
          <Button tone="primary" size="hit" className="agx-jd-primary shrink-0" data-dock="next" onClick={primary}
            data-tip={tipAttr({ name: life.next.label, text: isPrimaryLive ? "Brings the worker's tab forward." : life.next.body })}>
            {life.next.label}
          </Button>
        )}
        <Button size="hit" className="shrink-0" onClick={anchor("send")} aria-haspopup="menu" aria-expanded={menu?.which === "send"}
          data-tip={tipAttr({ name: "Send to terminal", text: "Start your agent on this card in a terminal window." })}>
          Send to terminal<CaretIcon size={ICON.xs} />
        </Button>
        <StartFlightPlan id={key} title={t.title} url={t.url} />
        {writable && <TrackerHandOffButton tracker={TRACKERS.jira} task={t} query={key} onSaid={setSaid} onTask={onTask} />}
        <span className="flex-1" />
        {root && <AskAboutButton cwd={root} what={key} onSaid={(ok, text) => setSaid(ok ? text : `!${text}`)} seed={() => cardSeed(t, detail, peekJiraDev(t.id)?.prs ?? [])} />}
        {follow && <JiraVote ui={follow} writes={writable} cardKey={key} />}
      </div>

      {menu?.which === "more" && <JiraMenuView menu={headerMenu(t, { back: !!onBack, watch: watch ? { on: watch.on, label: watch.on ? "Stop watching" : "Watch", why: canPress(watch) ? undefined : watch.title } : undefined, place: chrome ? { mode: chrome.mode } : undefined })} x={menu.x} y={menu.y} onPick={onPickMore} onClose={() => setMenu(null)} />}
      {menu?.which === "send" && <JiraMenuView menu={sendMenu(t, root)} x={menu.x} y={menu.y} onPick={onPickSend} onClose={() => setMenu(null)} />}
    </div>
  );
}
