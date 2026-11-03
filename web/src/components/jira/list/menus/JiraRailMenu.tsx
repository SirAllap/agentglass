/*
 * The sidebar's right-click menus for Jira: a saved filter or board (frame #menu-view) and the built-in
 * "Assigned to me" (#menu-me). Same skin and keys as the card menus (JiraMenu); TasksPanel draws these instead of its
 * plain menu when the source is Jira, and keeps its own for ClickUp.
 *
 * "Rename" is housekeeping of this machine only (viewPrefs.renameView): Jira is never asked. "Edit the search" is off
 * for a Jira filter and says where to do it.
 */
import { useState } from "react";
import type { SavedView } from "../../../../../../shared/providers.ts";
import { ContextMenu } from "../../../ContextMenu.tsx";
import { PopHead } from "../../../PrFilterPop.tsx";
import { Button, INPUT, INPUT_STYLE } from "../../../workspace/Chrome.tsx";
import { externalUrl, openExternal } from "../../../../lib/externalUrl.ts";
import { JiraMenuView } from "./JiraMenu.tsx";
import { meMenu, viewMenu } from "./menuModel.ts";
import { renameView, setRailHidden } from "./viewPrefs.ts";

export interface JiraRailMenuProps {
  v: SavedView;
  /** The cards the view holds, when it is the one on screen. */
  cards: number | null;
  x: number; y: number;
  onOpen: () => void;
  onReread: () => void;
  onTakeOff: () => void;
  onClose: () => void;
}

export function JiraRailMenu({ v, cards, x, y, onOpen, onReread, onTakeOff, onClose }: JiraRailMenuProps) {
  const [renaming, setRenaming] = useState(false);
  if (renaming) return <RenameBox v={v} x={x} y={y} onClose={onClose} />;

  const address = externalUrl(v.url);
  const menu = v.builtin ? meMenu(cards) : viewMenu(v, { cards, address, own: !v.folderId });
  const onPick = (id: string): void | "stay" => {
    switch (id) {
      case "open": onOpen(); return;
      case "reread": onReread(); return;
      case "openJira": openExternal(v.url); return;
      case "copyAddress": void navigator.clipboard?.writeText(v.url).catch(() => {}); return;
      case "rename": setRenaming(true); return "stay";
      case "takeOff": onTakeOff(); return;
      case "hideRail": setRailHidden(v.id, true); return;
    }
  };
  return <JiraMenuView menu={menu} x={x} y={y} onPick={onPick} onClose={onClose} />;
}

function RenameBox({ v, x, y, onClose }: { v: SavedView; x: number; y: number; onClose: () => void }) {
  const was = v.listName || v.name;
  const [text, setText] = useState(was);
  return (
    <ContextMenu x={x} y={y} onClose={onClose} width={268} label="Rename">
      <form className="p-2" onSubmit={(e) => { e.preventDefault(); renameView(v.id, text === was ? "" : text); onClose(); }}>
        <PopHead>Rename · only in this sidebar</PopHead>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.currentTarget.select()} aria-label="Name in this sidebar"
          className={`${INPUT} w-full`} style={INPUT_STYLE} />
        <div className="flex justify-end gap-1.5 mt-2"><Button size="compact" onClick={onClose}>Cancel</Button><Button size="compact" tone="primary" type="submit">Save</Button></div>
      </form>
    </ContextMenu>
  );
}
