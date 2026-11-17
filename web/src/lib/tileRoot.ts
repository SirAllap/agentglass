/*
 * The repo root the Tasks board's project maps to: the same `root` the pull request detail passes to api.prRerun. TasksPanel
 * provides it around the board; a card tile reads it when its button is clicked. A tile drawn outside a provider gets "", and
 * an empty root made the server rerun nothing, so a click with no root known is refused in words rather than sent.
 */
import { createContext, useContext } from "react";

export const TileRootContext = createContext("");
export function useTileRoot(): string { return useContext(TileRootContext); }
