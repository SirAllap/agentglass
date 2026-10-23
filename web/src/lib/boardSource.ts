/*
 * Where a Tasks board gets its boards, its cards and its writes from.
 *
 * `ClickUpBody` used to call `api.clickup*` at about forty places, so a second
 * tracker could only get a board by copying the whole body. This is the seam in
 * front of those calls: the body asks a `BoardSource`, and ClickUp is the
 * source it was written against. Every method here is the call it replaces,
 * with the same arguments in the same order, so a board backed by
 * `CLICKUP_BOARD` makes the requests it always made.
 *
 * What a second source has to supply:
 *
 *   views         the boards and folders on the rail, and which one was open
 *   read          one board: cards, the statuses in the tracker's own order,
 *                 the fields, where it sits, and the view's own address
 *   setWrites     the one switch that lets this app change anything
 *   address bar   add, replace and remove a board or a folder, and the slot
 *                 that draws the bar (a paste box here, a picker elsewhere)
 *   search        the workspace beyond the board on screen, whole or streamed
 *   caps          what the card pane may offer, so a control a tracker cannot
 *                 honour is not drawn at all rather than drawn and refused
 *   nouns         the words: list, board, "Open in ClickUp"
 *
 * What is not here yet, on purpose. The card pane (`CardDetail`) still writes
 * through `api.clickup*` and the pull request column still reads through
 * `cardPrStore`; moving them is the slice that gives a second tracker a card.
 * The board's `clickupWarm` and the id lookup that races the search sweep stay
 * where they are because tests pin the exact lines. The second source
 * (lib/jiraBoard.ts) supplies `caps`, `nouns` and `AddView`; ClickUp draws its
 * own bar and keeps its own words.
 *
 * Storage keys: the one formula below gives ClickUp the strings it has always
 * had (`agentglass.clickup.listRail`) and any other tracker its own id.
 */

import type { ComponentType, ReactNode } from "react";
import { api } from "./api.ts";
import { __forgetClickupSetup } from "./clickupSetup.ts";
import type { TrackerId } from "./trackerApi.ts";
import type { ClickUpBoards, ProviderTask, ViewTasksResponse } from "../../../shared/providers.ts";

/** What the card pane may offer. A source that cannot do a thing says so here
 *  and the control is left out, not disabled. */
export interface BoardCaps {
  /** Move a card into another sprint. */
  sprintEdit: boolean;
  /** More than one person on a card. */
  multiAssignee: boolean;
  /** Points, estimate, due, tags and custom fields can be edited. */
  fieldEdits: boolean;
  /** A list has saved views of its own, hung under it in the rail. */
  listViews: boolean;
  /** The search box can reach cards that are on no saved board. */
  workspaceSearch: boolean;
  /** That search can be read as it arrives. */
  stream: boolean;
  /** A card's own list can be asked for its statuses, fields and members. */
  listMeta: boolean;
  /** A board's saved address can be replaced by another. */
  editAddress: boolean;
  /** The built-in "assigned to you" read asks the whole workspace and is slow, with a quirk worth a note. */
  slowAssigned: boolean;
}

/** The words a board uses for the tracker's own things. */
export interface BoardNouns {
  /** "ClickUp". */
  tracker: string;
  space: string;
  folder: string;
  list: string;
  /** What a saved view is called on this tracker's bar. */
  board: string;
  /** "Open in ClickUp". */
  openIn: string;
  /** The tooltip over the add button. */
  addHint: string;
  /** What the built-in view is, in the tooltip on its rail row. */
  assignedHint: string;
}

/** The boards and folders a tracker has stored on this machine. A second
 *  source fills `writeEnabled` from its own switch. */
export type BoardViews = ClickUpBoards;

type Read<K extends keyof typeof api> = ReturnType<(typeof api)[K]>;

/** What the add-a-board slot is handed. The body keeps the state; the slot
 *  only draws and calls back. */
export interface AddViewSlotProps {
  value: string;
  onValue: (v: string) => void;
  onAdd: () => void;
  onClose: () => void;
  busy: boolean;
  /** The board whose address is being changed, when that is the errand. */
  editing?: string | null;
  /** A slot that picks rather than pastes says what it added: a board (its id, to land on) ... */
  onAddedView?: (id?: string) => void;
  /** ... or a whole folder. */
  onAddedFolder?: () => void;
}

export interface BoardSource {
  id: TrackerId;
  nouns: BoardNouns;
  caps: BoardCaps;
  /** The localStorage key for one remembered thing about this board's layout. */
  storageKey: (name: string) => string;

  views: () => Read<"clickupViews">;
  /** One board. `force` skips the server's cache. */
  read: (id?: string, force?: boolean) => Read<"clickupView">;
  /** One list's own statuses and fields, for a card that lives elsewhere. */
  list: (listId: string) => Read<"clickupList">;
  /** A list's own saved views, for the rail. Only asked when `caps.listViews`. */
  listViews: (listId: string) => Read<"clickupListViews">;
  setWrites: (on: boolean) => Read<"clickupSetWrites">;

  addView: (address: string) => Read<"clickupAddView">;
  replaceView: (id: string, address: string) => Read<"clickupReplaceView">;
  removeView: (id: string) => Promise<{ ok: boolean; error?: string }>;
  addFolder: (id: string, spaceName: string) => Read<"clickupAddFolder">;
  removeFolder: (id: string) => Read<"clickupRemoveFolder">;

  /** Is this card already on a board that is held? */
  where: (ref: string) => Read<"clickupWhere">;
  /** Fetch one card by reference. */
  find: (ref: string) => Read<"clickupFind">;
  search: (q: string, force?: boolean, signal?: AbortSignal) => Read<"clickupSearch">;
  searchStream: (
    q: string, force: boolean, onSome: Parameters<typeof api.clickupSearchStream>[2], signal?: AbortSignal,
  ) => Read<"clickupSearchStream">;

  /** The board's own address in the tracker, or nothing when it has none yet. */
  openAddress: (data: ViewTasksResponse | null) => string | undefined;

  /** The bar that adds a board. A source that has none leaves it out and the
   *  body keeps drawing its own. */
  AddView?: ComponentType<AddViewSlotProps>;
  /** The pane a card opens in. A source that has none leaves it out and the
   *  body draws ClickUp's. */
  CardPane?: ComponentType<CardPaneProps>;
}

export interface CardPaneProps {
  t: ProviderTask;
  /** Whether this app may change the tracker at all. */
  writable: boolean;
  /** A write changed the card: what the tracker now says. */
  onTask: (t: ProviderTask) => void;
  /** Next and previous, when the card is a dialog over the list. */
  nav?: ReactNode;
  /** Close it, when it is a dialog. */
  onClose?: () => void;
}

/** `agentglass.<tracker>.<name>`: ClickUp's keys as they were, others by id. */
export const boardStorageKey = (tracker: TrackerId, name: string): string => `agentglass.${tracker}.${name}`;

export const CLICKUP_BOARD: BoardSource = {
  id: "clickup",
  nouns: {
    tracker: "ClickUp", space: "space", folder: "folder", list: "list", board: "board", openIn: "Open in ClickUp",
    addHint: "Add a board by pasting its address",
    assignedHint: "Every card assigned to you, across the workspace, the same list as ClickUp's My Work. Slower than a board (it asks the whole workspace), so it opens on what you last saw.",
  },
  caps: {
    sprintEdit: true, multiAssignee: true, fieldEdits: true, listViews: true, workspaceSearch: true, stream: true,
    listMeta: true, editAddress: true, slowAssigned: true,
  },
  storageKey: (name) => boardStorageKey("clickup", name),

  views: () => api.clickupViews(),
  read: (id, force) => api.clickupView(id, force),
  list: (listId) => api.clickupList(listId),
  listViews: (listId) => api.clickupListViews(listId),
  /* The pull request sidebar reads this switch from a copy it holds for a
     minute, so the copy is dropped with the write. */
  setWrites: async (on) => {
    const r = await api.clickupSetWrites(on);
    __forgetClickupSetup();
    return r;
  },

  addView: (address) => api.clickupAddView(address),
  replaceView: (id, address) => api.clickupReplaceView(id, address),
  removeView: (id) => api.clickupRemoveView(id),
  addFolder: (id, spaceName) => api.clickupAddFolder(id, spaceName),
  removeFolder: (id) => api.clickupRemoveFolder(id),

  where: (ref) => api.clickupWhere(ref),
  find: (ref) => api.clickupFind(ref),
  search: (q, force, signal) => api.clickupSearch(q, force, signal),
  searchStream: (q, force, onSome, signal) => api.clickupSearchStream(q, force, onSome, signal),

  openAddress: (data) => data?.view?.url,
};
