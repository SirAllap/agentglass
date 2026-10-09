import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./workspace/Chrome.tsx";
import { Dot } from "./StatusPanel.tsx";
import { AnchoredMenu } from "./AnchoredMenu.tsx";
import { PeoplePick } from "./PeoplePick.tsx";
import { Face } from "./AssignPicker.tsx";
import { ArrowIcon, CaretIcon, CrossIcon, DoneIcon, GripIcon, PlusIcon, UserMinusIcon, UserPlusIcon, CommentIcon } from "../lib/glyphIcons.tsx";
import { ICON } from "../lib/iconSize.ts";
import { ASSIGN_LABEL, ASSIGN_WHO, assignLabel, type Assign } from "../lib/stepAssign.ts";
import { UNASSIGN_LABEL, type Unassign } from "../lib/workflowMap.ts";
import { BLOCK_INFO, blockRefusal, type StepTrigger } from "../../../shared/stepBlocks.ts";
import { AUTHOR_IS_MEMBER, type ListMember, type StepBlock } from "../../../shared/providers.ts";
import { moveBlock } from "../lib/stepBlocksView.ts";
import { shortName } from "../lib/askAtRun.ts";

/**
 * The blocks of one step: what it does, as a list the person builds.
 *
 * Each block is a row with a handle, what it is, its value, and a remove. The
 * list's order is the order it reads in (the sentence under it is built from it).
 * Rows are told apart by their kind, because a step holds one of each, so a row
 * keeps its element, and the focus on it, while it moves.
 *
 * Reordering is the pointer (drag the handle) and the keyboard (arrow keys on the
 * handle), and both end in the same `onChange`. A drag works on a copy of the order
 * and writes nothing until the pointer is released; Escape puts it back.
 *
 * The status of a move block is picked by the map, which owns the lists of statuses
 * and the lines drawn to them (`onPickStatus`); the other two values are small
 * lists and live here.
 */

/** Somebody the "a person…" choice can name. */
export interface MapPerson { id: number; name: string; sub?: string }


/*
 * The small lists: who comes off, who to assign, which block to add.
 *
 * Each is an AnchoredMenu: drawn on the body, placed against its own trigger with the
 * list's real height, flipped or shifted to stay on screen. They used to hang from the
 * status popover, which guessed a 430px list and put a three-row one ~400px above the
 * button that opened it. Arrow keys, Home, End and Escape are the menu's own.
 */
type Anchor = React.RefObject<HTMLElement | null>;
const Row = ({ selected, onClick, children, disabled, ...rest }: { selected?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean } & React.HTMLAttributes<HTMLButtonElement>) => (
  <button type="button" role="menuitem" className="wfm-opt" aria-current={selected || undefined} aria-disabled={disabled || undefined} onClick={onClick} {...rest}>{children}</button>
);
const Check = ({ on }: { on: boolean }) => <span className="ck" aria-hidden>{on ? <DoneIcon size={ICON.xs} /> : null}</span>;

/** Who comes off: nobody, only you, everyone, or named people (the app's one people picker, ticks, stays open). */
export function UnassignMenu({ anchor, value, people, onPick, onPeople, onClose }: { anchor: Anchor; value: { who: Unassign | "people"; people?: { id: number; name: string }[] }; people?: () => Promise<MapPerson[] | null>; onPick: (who: Unassign) => void; onPeople: (list: { id: number; name: string }[]) => void; onClose: () => void }) {
  const [view, setView] = useState<"choice" | "people">("choice");
  const [list, setList] = useState<MapPerson[] | null | "reading">("reading");
  useEffect(() => {
    if (view !== "people") return;
    let live = true;
    setList("reading");
    void (people?.() ?? Promise.resolve(null)).catch(() => null).then((r) => { if (live) setList(r); });
    return () => { live = false; };
  }, [view, people]);
  if (view === "people") {
    const rows: ListMember[] = list === "reading" || list === null ? [] : list.map((m) => ({ id: m.id, name: m.name, initials: m.name.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase() }));
    const now = value.who === "people" ? value.people ?? [] : [];
    return (
      <PeoplePick anchor={anchor} members={rows} busy={list === "reading"} filterOver={12}
        empty={list === null ? "The people could not be read." : "Nobody to pick."}
        isOn={(m) => now.some((x) => x.id === m.id)}
        face={(m) => <Face m={m} />}
        onPick={(m) => onPeople(now.some((x) => x.id === m.id) ? now.filter((x) => x.id !== m.id) : [...now, { id: m.id, name: m.name }])}
        onClose={onClose} />
    );
  }
  return (
    <AnchoredMenu anchor={anchor} align="left" minWidth={200} onClose={onClose}>
      <div className="wfm" style={{ display: "contents" }}>
        {(["none", "me", "all"] as const).map((w) => <Row key={w} selected={value.who === w} onClick={() => onPick(w)}><Check on={value.who === w} /><span className="n">{UNASSIGN_LABEL[w]}</span></Row>)}
        <Row selected={value.who === "people"} onClick={() => setView("people")}><Check on={value.who === "people"} /><span className="n">people…</span></Row>
      </div>
    </AnchoredMenu>
  );
}

/** The answers to "Assign"; "a person…" goes on to the people, read only when asked for. */
export function AssignMenu({ anchor, value, people, withNobody, also, onPeople, onPick, onClose }: { anchor: Anchor; value: Assign; /** For a block that asks: the people the question starts with, beside `value.person`. */ also?: { id: number; name: string }[]; /** The picked people changed (the list stays open: a block that asks may start with several). */ onPeople?: (list: { id: number; name: string }[]) => void; /** The picker may start at nobody (only a block that asks when it runs). */ withNobody?: boolean; people?: () => Promise<MapPerson[] | null>; onPick: (a: Assign) => void; onClose: () => void }) {
  const [view, setView] = useState<"choice" | "people">("choice");
  const [list, setList] = useState<MapPerson[] | null | "reading">("reading");
  useEffect(() => {
    if (view !== "people") return;
    let live = true;
    setList("reading");
    void (people?.() ?? Promise.resolve(null)).catch(() => null).then((r) => { if (live) setList(r); });
    return () => { live = false; };
  }, [view, people]);
  /* "A person…" is the app's one people picker (components/PeoplePick), anchored where the choice was. */
  if (view === "people") {
    const rows: ListMember[] | null = list === "reading" || list === null ? null : list.map((m) => ({ id: m.id, name: m.name, initials: m.name.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase() }));
    return (
      <PeoplePick anchor={anchor} members={rows ?? []} busy={list === "reading"} filterOver={8}
        empty={list === null ? "The people could not be read." : "Nobody to pick."}
        isOn={(m) => value.who === "person" && (value.person?.id === m.id || !!also?.some((x) => x.id === m.id))}
        face={(m) => <Face m={m} />}
        onPick={(m) => {
          if (!onPeople) { onPick({ who: "person", person: { id: m.id, name: m.name } }); return; }
          const now = value.who === "person" && value.person ? [{ id: value.person.id, name: value.person.name }, ...(also ?? [])] : [];
          onPeople(now.some((x) => x.id === m.id) ? now.filter((x) => x.id !== m.id) : [...now, { id: m.id, name: m.name }]);
        }}
        onClose={onClose} />
    );
  }
  return (
    <AnchoredMenu anchor={anchor} align="left" minWidth={200} onClose={onClose}>
      <div className="wfm" style={{ display: "contents" }}>
        {ASSIGN_WHO.filter((w) => (w !== "none" || withNobody) && (w !== "author" || AUTHOR_IS_MEMBER.clickup)).map((w) => (
          <Row key={w} selected={value.who === w} onClick={() => (w === "person" ? setView("people") : onPick({ who: w }))}><Check on={value.who === w} /><span className="n">{w === "none" ? "nobody" : ASSIGN_LABEL[w]}</span></Row>))}
      </div>
    </AnchoredMenu>
  );
}

/** The same block, fixed again: its value stays, the question goes. A fixed assign cannot be "nobody", so that goes to the person pressing. */
const withoutAsk = (b: StepBlock): StepBlock => {
  if (b.type === "move") { const { ask: _a, ...rest } = b; return rest; }
  if (b.type === "assign") { const { ask: _a, also: _o, ...rest } = b; return rest.who === "none" ? { type: "assign", who: "me" } : rest; }
  if (b.type === "unassign") { const { ask: _a, ...rest } = b; return rest.who === "people" && !rest.people?.length ? { type: "unassign", who: "none" } : rest; }
  return b;
};
const hint = (c: ReactNode) => <span className="text-[11px]" style={{ color: "var(--text3)" }}>{c}</span>;
const GLYPH: Record<string, (p: { size?: number }) => React.ReactElement> = { move: ArrowIcon, unassign: UserMinusIcon, assign: UserPlusIcon, comment: CommentIcon, field: ListGlyph };
function ListGlyph({ size }: { size?: number }) { return <PlusIcon size={size} />; }

const titleOf = (b: StepBlock["type"], trigger: StepTrigger, n: { item: string; verb: string }): string =>
  b === "move" ? (trigger === "merge" ? "Preselect" : `${n.verb} the ${n.item} to`) : b === "unassign" ? `Take people off the ${n.item}` : "Assign the " + n.item + " to";
const hintOf = (b: StepBlock["type"], trigger: StepTrigger, n: { item: string }): string =>
  b === "move" ? (trigger === "merge" ? "Offered at merge time; you can still change it" : `Where the ${n.item} goes`)
    : b === "unassign" ? "Who comes off" : trigger === "merge" ? "Added if missing, when the merge moves the card" : "Added if missing";

type Open = { type: StepBlock["type"] | "add" };

export interface StepBlocksProps {
  trigger: StepTrigger;
  blocks: StepBlock[];
  /** The move block's status once the built-in guess is resolved; null while none is picked. */
  status: string | null;
  statusType: string;
  statusColor?: string;
  /** The move block's value needs attention: nothing picked, or a status no list has. */
  moveTone?: "empty" | "bad" | "ignored";
  n: { item: string; verb: string };
  frozen?: boolean;
  people?: () => Promise<MapPerson[] | null>;
  onChange: (next: StepBlock[]) => void;
  onPickStatus: (anchor: HTMLElement) => void;
  /** The map's own popover for a status is open on this step. */
  statusOpen: boolean;
}

export function StepBlocks(p: StepBlocksProps) {
  const { trigger, n } = p;
  const uid = useId();
  const [open, setOpen] = useState<Open | null>(null);
  /* The control whose list is open, read by the list each time it is placed. */
  const anchorRef = useRef<HTMLElement | null>(null);
  const openAt = (type: Open["type"], el: HTMLElement) => { anchorRef.current = el; setOpen({ type }); };
  const [drag, setDrag] = useState<{ type: StepBlock["type"]; gy: number; left: number; w: number; h: number; y: number; order: StepBlock[]; start: StepBlock[] } | null>(null);
  /* What the list will be once the save lands: a drop or a removal shows at once instead of snapping back. */
  const [pending, setPending] = useState<StepBlock[] | null>(null);
  const [undo, setUndo] = useState<{ block: StepBlock; at: number } | null>(null);
  const [said, setSaid] = useState("");
  const [added, setAdded] = useState<StepBlock["type"] | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const box = useRef<HTMLDivElement>(null);
  const focusNext = useRef<string | null>(null);

  useEffect(() => { setPending(null); }, [p.blocks]);
  useEffect(() => { if (pending) { const t = setTimeout(() => setPending(null), 3000); return () => clearTimeout(t); } }, [pending]);
  const shown = drag ? drag.order : (pending ?? p.blocks);
  const commit = (next: StepBlock[]) => { setPending(next); p.onChange(next); };

  /* A block just added opens its own value, as soon as the saved list shows it. */
  useEffect(() => {
    if (!added) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-blk="${added}"] [data-val]`);
    if (!el) { const t = setTimeout(() => setAdded(null), 2500); return () => clearTimeout(t); }
    setAdded(null);
    if (added === "move") p.onPickStatus(el); else openAt(added, el);
  }, [added, p.blocks]);
  useLayoutEffect(() => {
    if (!focusNext.current) return;
    const el = box.current?.querySelector<HTMLElement>(focusNext.current);
    if (el) { el.focus(); focusNext.current = null; }
  });

  /* ---- drag ---- */
  const startDrag = (e: React.PointerEvent, type: StepBlock["type"]) => {
    if (p.frozen || e.button !== 0) return;
    const el = rows.current.get(type);
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    setOpen(null); setUndo(null);
    setDrag({ type, gy: e.clientY - r.top, left: r.left, w: r.width, h: r.height, y: e.clientY, order: shown, start: shown });
  };
  /* The drag lives in a ref as well as in state: the listeners below are made once per drag and must read the
     latest position, and the drop must not do its work inside a state updater (which React may run twice). */
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const latest = useRef({ commit, trigger, n });
  latest.current = { commit, trigger, n };
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (e.clientY < 70) window.scrollBy(0, -14); else if (e.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
      const mid = e.clientY - d.gy + d.h / 2;
      let idx = 0;
      for (const b of d.order) {
        if (b.type === d.type) continue;
        const r = rows.current.get(b.type)?.getBoundingClientRect();
        if (r && r.top + r.height / 2 < mid) idx++;
      }
      const cur = d.order.findIndex((b) => b.type === d.type);
      setDrag({ ...d, y: e.clientY, order: idx === cur ? d.order : moveBlock(d.order, cur, idx) });
    };
    const end = (keep: boolean) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      const changed = d.order.some((b, i) => b !== d.start[i]);
      if (keep && changed) {
        latest.current.commit(d.order);
        setSaid(`Dropped “${titleOf(d.type, latest.current.trigger, latest.current.n)}” at position ${d.order.findIndex((b) => b.type === d.type) + 1} of ${d.order.length}.`);
      }
      focusNext.current = `[data-blk="${d.type}"] [data-grip]`;
      setDrag(null);
    };
    const up = () => end(true), cancel = () => end(false);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); end(false); } };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", cancel); document.removeEventListener("keydown", esc, true); };
  }, [!!drag]);

  const keyMove = (e: React.KeyboardEvent, i: number, b: StepBlock) => {
    const to = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? shown.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    if (p.frozen || to < 0 || to >= shown.length || to === i) return;
    commit(moveBlock(shown, i, to));
    setUndo(null);
    setSaid(`Moved “${titleOf(b.type, trigger, n)}” to position ${to + 1} of ${shown.length}.`);
  };

  const remove = (i: number) => {
    const b = shown[i]!;
    commit(shown.filter((_, j) => j !== i));
    setUndo({ block: b, at: i }); setOpen(null);
    const nb = shown[i + 1] ?? shown[i - 1];
    focusNext.current = nb ? `[data-blk="${nb.type}"] [data-grip]` : "[data-addblock]";
    setSaid(`Removed “${titleOf(b.type, trigger, n)}”.`);
  };
  const restore = () => {
    if (!undo) return;
    const next = [...shown]; next.splice(Math.min(undo.at, next.length), 0, undo.block);
    commit(next);
    focusNext.current = `[data-blk="${undo.block.type}"] [data-grip]`;
    setSaid(`Restored “${titleOf(undo.block.type, trigger, n)}”.`);
    setUndo(null);
  };
  const add = (type: string) => {
    if (blockRefusal(trigger, shown, type)) return;
    const b: StepBlock = type === "move" ? { type: "move", statusNames: [] } : type === "unassign" ? { type: "unassign", who: "none" } : { type: "assign", who: "me" };
    commit([...shown, b]);
    setUndo(null); setOpen(null); setAdded(b.type);
    setSaid(`Added “${titleOf(b.type, trigger, n)}” at position ${shown.length + 1}.`);
  };
  const setBlock = (type: StepBlock["type"], b: StepBlock, then?: string, keepOpen = false) => {
    commit(shown.map((x) => (x.type === type ? b : x)));
    setUndo(null);
    if (!keepOpen) { setOpen(null); focusNext.current = then ?? `[data-blk="${type}"] [data-val]`; }
  };

  /* ---- a row ---- */
  const valueButton = (b: StepBlock, i: number) => {
    const id = `${uid}-${b.type}`;
    const common = { type: "button" as const, "data-val": "", className: "wfm-pick", disabled: p.frozen, "aria-haspopup": "listbox" as const, "aria-labelledby": `${id}-l ${id}-v` };
    if (b.type === "move") {
      const label = p.status ?? (trigger === "merge" ? "Leave it there" : "Pick a status");
      const shown = b.ask ? `Start at: ${label}` : label;
      return (
        <button {...common} data-pick="" aria-expanded={p.statusOpen}
          {...(p.moveTone === "bad" ? { "data-bad": "" } : p.moveTone ? { "data-empty": "" } : null)}
          onClick={(e) => p.onPickStatus(e.currentTarget)}>
          {p.status && <Dot type={p.statusType} color={p.statusColor} />}<span id={`${id}-v`}>{shown}</span><span className="cv" aria-hidden><CaretIcon size={ICON.xs} /></span>
        </button>
      );
    }
    const unLabel = b.type === "unassign" ? (b.who === "people" ? (b.people ?? []).map((x) => shortName(x.name)).join(", ") || "people…" : UNASSIGN_LABEL[b.who]) : "";
    const label = b.type === "unassign" ? (b.ask ? `Start at: ${unLabel}` : unLabel) : b.ask ? `Start at: ${b.who === "none" ? "nobody" : b.who === "person" && b.also?.length ? [b.person!.name, ...b.also.map((x) => x.name)].map(shortName).join(", ") : assignLabel(b)}` : assignLabel(b);
    return (
      <button {...common} data-plain="" aria-expanded={open?.type === b.type}
        onClick={(e) => (open?.type === b.type ? setOpen(null) : openAt(b.type, e.currentTarget))}>
        <span id={`${id}-v`}>{label}</span><span className="cv" aria-hidden><CaretIcon size={ICON.xs} /></span>
      </button>
    );
  };
  const row = (b: StepBlock, i: number, mode?: "slot" | "drag") => {
    const Icon = GLYPH[b.type]!;
    const id = `${uid}-${b.type}`;
    const style = mode === "drag" ? { top: drag!.y - drag!.gy, left: drag!.left, width: drag!.w, height: drag!.h } : mode === "slot" ? { height: drag!.h } : undefined;
    return (
      <div key={mode === "drag" ? `${b.type}-drag` : b.type} data-blk={b.type} role="group" aria-label={`Block ${i + 1}: ${titleOf(b.type, trigger, n)}`}
        ref={(el) => { if (el && !mode) rows.current.set(b.type, el); else if (!el && !mode) rows.current.delete(b.type); }}
        className="wfm-blk" {...(mode ? { "data-mode": mode } : null)} style={style}>
        <button type="button" data-grip="" className="wfm-grip" disabled={p.frozen} aria-roledescription="drag handle"
          aria-label={`Reorder “${titleOf(b.type, trigger, n)}”. Drag it, or press arrow up and down.`}
          onPointerDown={(e) => startDrag(e, b.type)} onKeyDown={(e) => keyMove(e, i, b)}><GripIcon size={ICON.md} /></button>
        <span className="wfm-lb"><b id={`${id}-l`} className="text-[13px] inline-flex items-center gap-2"><span className="wfm-gl"><Icon size={ICON.xs} /></span>{titleOf(b.type, trigger, n)}</b>{hint(hintOf(b.type, trigger, n))}{(b.type === "move" || b.type === "assign" || b.type === "unassign") && (
            <button type="button" data-ask="" className="wfm-ask" aria-pressed={b.ask === true} disabled={p.frozen}
              title={b.ask ? "It asks when it runs; the value is where the question starts. Press to fix it." : "Fix this value, or ask when it runs: the value becomes where the question starts."}
              onClick={() => setBlock(b.type, b.ask ? withoutAsk(b) : { ...b, ask: true } as StepBlock, '[data-blk="' + b.type + '"] [data-ask]')}>Ask when it runs</button>
          )}</span>
        <span className="relative">{valueButton(b, i)}</span>
        <button type="button" data-rmb="" className="wfm-rmx" disabled={p.frozen} aria-label={`Remove block: ${titleOf(b.type, trigger, n)}`} onClick={() => remove(i)}><CrossIcon size={ICON.xs} /></button>
      </div>
    );
  };

  const dragged = drag ? shown.findIndex((b) => b.type === drag.type) : -1;
  const list = shown.map((b, i) => (drag && b.type === drag.type ? row(b, i, "slot") : row(b, i)));
  const cur = open && open.type !== "add" ? shown.find((b) => b.type === open.type) : null;

  return (
    <div ref={box} className="flex flex-col gap-2">
      <div className="wfm-blks" role="list" aria-label="Blocks, in the order they run">
        {shown.length === 0 && <div className="flex flex-col gap-1 items-start p-4"><b className="text-[13px]">{trigger === "merge" ? "No blocks" : "No blocks yet"}</b>{hint(trigger === "merge" ? "The merge dialog offers the card choice with nothing preselected. Add a block to change that." : "A step is a place plus the blocks you add. Add the first one.")}</div>}
        {list}
        {drag && dragged >= 0 && row(shown[dragged]!, dragged, "drag")}
        <div className="wfm-addrow">
          <Button size="compact" data-addblock="" aria-haspopup="menu" aria-expanded={open?.type === "add"} disabled={p.frozen}
            onClick={(e) => (open?.type === "add" ? setOpen(null) : openAt("add", e.currentTarget))}><PlusIcon size={ICON.xs} /> Add a block</Button>
          <span className="flex-1" />
          {hint("Runs top to bottom, sent to the tracker in as few writes as it allows.")}
        </div>
      </div>
      {undo && <div className="wfm-undo" role="status">Removed “{titleOf(undo.block.type, trigger, n)}”. <Button size="compact" onClick={restore}>Undo</Button></div>}
      <div className="sr-only" role="status" aria-live="polite">{said}</div>
      {open?.type === "add" && (
        <AnchoredMenu anchor={anchorRef} align="left" minWidth={380} onClose={() => { setOpen(null); focusNext.current = "[data-addblock]"; }}>
          <div className="wfm" style={{ display: "contents" }}>
            {BLOCK_INFO.map((info) => {
              const why = blockRefusal(trigger, shown, info.type);
              const I = GLYPH[info.type] ?? PlusIcon;
              return (
                <Row key={info.type} disabled={!!why} data-add={info.type} onClick={() => { if (!why) add(info.type); }}>
                  <span className="wfm-gl"><I size={ICON.xs} /></span>
                  <span className="n wfm-blkopt"><b className="text-[13px]">{info.name}</b>{hint(info.blurb)}{why && <span className="wfm-why">{why}</span>}</span>
                </Row>
              );
            })}
          </div>
        </AnchoredMenu>
      )}
      {cur?.type === "unassign" && (
        <UnassignMenu anchor={anchorRef} value={cur} people={p.people}
          onPick={(who) => setBlock("unassign", { type: "unassign", who, ...(cur.ask ? { ask: true as const } : null) })}
          onPeople={(list) => setBlock("unassign", { type: "unassign", who: list.length ? "people" : "none", ...(list.length ? { people: list } : null), ...(cur.ask ? { ask: true as const } : null) }, undefined, true)}
          onClose={() => { setOpen(null); focusNext.current = '[data-blk="unassign"] [data-val]'; }} />
      )}
      {cur?.type === "assign" && (
        <AssignMenu anchor={anchorRef} value={cur} people={p.people} withNobody={cur.ask === true} {...(cur.ask ? { also: cur.also, onPeople: (list: { id: number; name: string }[]) => setBlock("assign", list.length ? { type: "assign", ask: true, who: "person", person: list[0]!, ...(list.length > 1 ? { also: list.slice(1) } : null) } : { type: "assign", ask: true, who: "none" }, undefined, true) } : null)} onPick={(a) => setBlock("assign", a.who === "none" && !cur.ask ? cur : { type: "assign", ...(cur.ask ? { ask: true as const } : null), ...a })}
          onClose={() => { setOpen(null); focusNext.current = '[data-blk="assign"] [data-val]'; }} />
      )}
    </div>
  );
}
