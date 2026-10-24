import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { ProviderUsage } from "../../../shared/types.ts";
import { accountLists, colourOf, MANAGER_NAME, peakOf, pressAccount, readingFor, refreshAccounts, subscribeAccounts } from "../lib/accountStore.ts";
import { decideKey, keyHints, proposalLine, stepIndex, tabTarget, type KeyState } from "../lib/accountKeys.ts";
import { accountStageOf, clearStage, peekStage, subscribeStage } from "../lib/stageIntent.ts";
import { providerUsage, usageOf } from "../lib/usageStore.ts";
import { openSettings } from "../lib/openSettings.ts";
import { HIT, MIN_BOX } from "../lib/iconSize.ts";
import { Button, EDGE, LINE } from "./workspace/Chrome.tsx";

/*
 * The accounts of a provider, as chips under the popover's header.
 *
 * The plugin that keeps the list owns the switching; this draws what it said
 * and passes the person's press on. Which chip is in focus decides which
 * reading the bars below show: the core's own for the one in use, the plugin's
 * for another, and "no reading yet" until it has sent one.
 */

type Note = { text: string; bad: boolean };

/**
 * State and keys of the chips. PlanPanel owns the layout and asks this for the
 * row to draw bars from, plus the props that make its root take the keyboard.
 * `u` is the row the strip chose; ↑↓ may move to another provider that has
 * accounts and a reading of its own.
 */
export function useAccountPanel(u: ProviderUsage, onClose: () => void, onEscape: () => void, focusIn: boolean) {
  const lists = useSyncExternalStore(subscribeAccounts, accountLists, accountLists);
  const proposal = useSyncExternalStore(subscribeStage, () => accountStageOf(peekStage()), () => null);
  const [provider, setProvider] = useState<ProviderUsage["provider"]>(u.provider);
  const [candId, setCandId] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const chipEls = useRef(new Map<string, HTMLButtonElement>());
  // Whether the person has been inside: a popover an agent opened beside their
  // typing is not modal, and Tab typed elsewhere is not ours until they enter.
  const engaged = useRef(false);
  const [modal, setModal] = useState(focusIn);

  // Opening the popover is a reason to read the lists; focus goes in so the keys
  // work whether it was opened by mouse or keyboard (the scrim covers the strip).
  // Not when an agent's proposal opened it: the person may be typing somewhere
  // else, and their next key must go where they were typing.
  useEffect(() => { if (focusIn) root.current?.focus({ preventScroll: true }); void refreshAccounts(); }, []);

  // Tab stays inside while the person is in the popover. On the document, not
  // the root: a press disables the button that had focus, focus drops to the
  // page behind the scrim, and a handler on the root never hears the next Tab.
  useEffect(() => {
    const trap = (e: globalThis.KeyboardEvent) => {
      const el = root.current;
      if (e.key !== "Tab" || !el || e.ctrlKey || e.metaKey || e.altKey) return;
      const active = document.activeElement;
      if (!el.contains(active) && !(engaged.current && (!active || active === document.body))) return;
      const items = [...el.querySelectorAll<HTMLElement>("button:not([disabled]):not([tabindex='-1']), [tabindex='0']")];
      const to = tabTarget(active ? items.indexOf(active as HTMLElement) : -1, items.length, e.shiftKey);
      if (to === null) return;
      e.preventDefault();
      items[to]?.focus();
    };
    document.addEventListener("keydown", trap);
    return () => document.removeEventListener("keydown", trap);
  }, []);
  const keepFocusIn = () => { if (root.current && !root.current.contains(document.activeElement)) root.current.focus({ preventScroll: true }); };

  const usable = lists.filter((l) => l.accounts.length > 0 && (l.provider === u.provider || usageOf(l.provider)));
  const shown = usable.some((l) => l.provider === provider) ? provider : u.provider;
  const list = usable.find((l) => l.provider === shown) ?? null;
  const accounts = list?.accounts ?? [];
  const activeAt = accounts.findIndex((a) => a.active);
  const found = accounts.findIndex((a) => a.id === candId);
  const at = found >= 0 ? found : Math.max(0, activeAt);
  const cand = accounts[at] ?? null;
  const managed = !!list?.managedBy;

  // An agent's proposal shows the provider it names, and selects no chip: a key
  // pressed next must never mean the agent's pick.
  const pn = proposal?.n;
  useEffect(() => { if (proposal) setProvider(proposal.a.provider); }, [pn]);

  const offerList = proposal ? lists.find((l) => l.provider === proposal.a.provider) : undefined;
  const offered = proposal ? offerList?.accounts.find((a) => a.id === proposal.a.id) : undefined;
  const offer = proposal && offerList && offered && !offered.active && !offerList.managedBy
    ? { by: proposal.by, provider: proposal.a.provider, account: offered }
    : null;

  const row = cand ? readingFor(providerUsage(), shown, cand) : null;
  const header = shown === u.provider ? u : usageOf(shown) ?? u;

  const ks: KeyState = { providers: usable.length, accounts: accounts.length, candidateActive: !!cand?.active, managed, proposal: !!offer, busy };

  const doSwitch = async (prov: string, id: string, label: string) => {
    setBusy(true);
    setNote({ text: "Asking the plugin to switch…", bad: false });
    const r = await pressAccount("switch", prov, id);
    setBusy(false);
    keepFocusIn();
    setNote(r.ok ? { text: `Asked to switch to ${label}. The chips update when the plugin answers.`, bad: false } : { text: `Could not switch: ${plain(r.error)}.`, bad: true });
    if (r.ok) setCandId(id);
  };
  const doManage = async () => {
    setBusy(true);
    const r = await pressAccount("manage", shown);
    setBusy(false);
    keepFocusIn();
    if (r.ok && r.plugin) { onClose(); openSettings(`plugin:${r.plugin}`); }
    else setNote({ text: `Could not open the plugin: ${plain(r.error)}.`, bad: true });
  };
  // The card's own button had focus and is gone with it: put focus back so the keys keep working.
  const dismiss = () => { clearStage(); root.current?.focus({ preventScroll: true }); };
  const confirmOffer = async () => {
    if (!offer) return;
    await doSwitch(offer.provider, offer.account.id, offer.account.label);
    dismiss();
  };

  const act = (a: "switch" | "manage") => {
    if (a === "manage") void doManage();
    else if (cand) void doSwitch(shown, cand.id, cand.label);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const d = decideKey(ks, e.key);
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    if (d.do === "close") onEscape();
    else if (d.do === "dismiss") dismiss();
    else if (d.do === "candidate") {
      const id = accounts[stepIndex(at, d.step, accounts.length)]?.id ?? null;
      setCandId(id);
      // The chip takes focus, so a screen reader says which one it is on.
      if (id) chipEls.current.get(id)?.focus({ preventScroll: true });
    }
    else if (d.do === "provider") {
      const i = usable.findIndex((l) => l.provider === shown);
      setProvider(usable[stepIndex(i, d.step, usable.length)]!.provider);
      setCandId(null);
    } else act(d.do);
  };

  return {
    show: !!list && !!cand,
    header, row, cand, accounts, list, managed, offer, note, busy, ks, at,
    atCore: !!cand?.active,
    pick: setCandId, chipRef: (id: string) => (el: HTMLButtonElement | null) => { if (el) chipEls.current.set(id, el); else chipEls.current.delete(id); },
    act, confirmOffer, dismissOffer: dismiss,
    rootProps: {
      ref: root, tabIndex: -1, onKeyDown, role: "dialog", "aria-label": `${header.label} plan usage`, "aria-modal": modal,
      onFocus: () => { engaged.current = true; setModal(true); },
    } as const,
  };
}

export type AccountPanel = ReturnType<typeof useAccountPanel>;

const dim = { color: "var(--text4)" } as const;
/** Lines the status line has room for. It wraps rather than cuts, and keeps its room when empty so that an answer moves nothing. */
const NOTE_LINES = 2;
const NOTE_LINE_H = 14;
const plain = (e?: string) => (e ?? "the app refused").replace(/\.$/, "");

/** The chips, the line under them and the proposal card. Nothing when the provider has no accounts. */
export function AccountChips({ p }: { p: AccountPanel }) {
  if (!p.show || !p.cand) return null;
  const rows = providerUsage();
  const provName = (id: string) => usageOf(id as ProviderUsage["provider"])?.label ?? id;
  return (
    <div style={{ borderBottom: LINE }}>
      <div role="radiogroup" aria-label="Accounts" className="flex flex-col gap-0.5 px-2 pt-2">
        {p.accounts.map((a) => {
          const sel = a.id === p.cand!.id;
          const peak = peakOf(readingFor(rows, p.list!.provider, a));
          return (
            <button key={a.id} ref={p.chipRef(a.id)} type="button" role="radio" aria-checked={sel} tabIndex={sel ? 0 : -1} onClick={() => p.pick(a.id)}
              className="flex items-center gap-2 rounded px-2 text-left w-full hover:bg-white/10"
              style={{ height: HIT, background: sel ? "color-mix(in srgb, var(--text) 9%, transparent)" : "transparent", color: a.active ? "var(--text)" : "var(--text3)" }}>
              <span aria-hidden className="shrink-0 rounded-full" style={{ width: 8, height: 8, background: colourOf(a.colour) }} />
              <span className="truncate min-w-0 text-[11.5px]">{a.label}<span style={dim}> · {a.plan}</span></span>
              {peak !== null && <span className="ml-auto shrink-0 text-[10px] tabular-nums">{peak}% peak</span>}
              {a.active && <span className={`chip text-[10px] shrink-0 ${peak === null ? "ml-auto" : ""}`} style={{ color: "var(--text)" }}>active</span>}
            </button>
          );
        })}
      </div>
      {/* One line that is always there: storage on the left, who manages on the right. */}
      <div className="flex items-center gap-2 px-3 text-[10px]" style={{ ...dim, height: MIN_BOX }}>
        {p.cand.storage === "file" ? <span className="chip text-[10px]">stored in a file</span> : <span>stored in the keyring</span>}
        {p.managed && <span className="ml-auto truncate">Managed by {MANAGER_NAME[p.list!.managedBy!] ?? p.list!.managedBy}</span>}
      </div>
      <div aria-live="polite" className="px-3 pb-1.5 text-[10px]" style={{ minHeight: NOTE_LINES * NOTE_LINE_H + 6, lineHeight: `${NOTE_LINE_H}px`, color: p.note?.bad ? "var(--error-ink)" : "var(--text3)" }}>{p.note?.text}</div>
      {/* Below the chips and their line, not above: a card that arrives while the
          person is aiming at a chip must not push it. */}
      {p.offer && (
        <div role="group" aria-label="Proposed switch" className="mx-3 mb-2 rounded-lg px-2.5 py-2 flex flex-col gap-1.5"
          style={{ border: EDGE, background: "var(--surface-inset)" }}>
          <span className="text-[11.5px]" style={{ color: "var(--text)" }}>
            {proposalLine(p.offer.by, provName(p.offer.provider), p.offer.account.label)}
          </span>
          <span className="text-[10px]" style={dim}>Nothing changes until you press Switch.</span>
          <div className="flex gap-2">
            <Button size="compact" tone="primary" disabled={p.busy} onClick={() => void p.confirmOffer()}>Switch to {p.offer.account.label}</Button>
            <Button size="compact" onClick={p.dismissOffer}>Not now</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The key bar. `a` and `m` are also buttons, so the mouse reaches what the keys do. */
export function AccountKeyBar({ p }: { p: AccountPanel }) {
  if (!p.show) return null;
  const hints = keyHints(p.ks);
  if (!hints.length) return null;
  return (
    <div className="flex items-center gap-3 px-3 text-[10px]" style={{ ...dim, borderTop: LINE, height: HIT }}>
      {hints.map((h) => {
        const inner = <><kbd className="rounded px-1 text-[9.5px]" style={{ border: EDGE }}>{h.keys}</kbd> {h.label}</>;
        return h.act
          ? <button key={h.keys} type="button" disabled={!h.enabled} onClick={() => p.act(h.act!)}
              className="rounded hover:bg-white/10 disabled:opacity-40" style={{ height: MIN_BOX, paddingInline: 2 }}>{inner}</button>
          : <span key={h.keys}>{inner}</span>;
      })}
    </div>
  );
}
