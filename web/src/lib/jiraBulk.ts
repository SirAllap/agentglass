/* The bulk bar's calls to the server, kept out of the list components: one change to several cards, and the choices its menus offer. */
import { api } from "./api.ts";
import type { JiraPerson } from "../../../shared/providers.ts";

export type BulkOptions = Awaited<ReturnType<typeof api.jiraBulkOptions>>;
export interface BulkWire { kind: string; value?: unknown; add?: string[] | undefined; remove?: string[] | undefined }

/** Never rejects: a network failure comes back as one sentence with no results. */
export const bulkWrite = (keys: string[], change: BulkWire) =>
  api.jiraBulk(keys, change).catch(() => ({ ok: false, error: "Could not reach the server", results: [] as Array<{ key: string; ok: boolean; error?: string }> }));
export const bulkOptions = (board: string): Promise<BulkOptions | null> => api.jiraBulkOptions(board).catch(() => null);
export const bulkPeople = (project: string): Promise<JiraPerson[]> => api.jiraMembers(project).then((r) => r.people ?? [], () => []);

/** The reads that find the picked card's board when the view is no board's (the same two the card menu makes). */
export const BOARD_READS = { projectBoards: (k: string) => api.jiraProjectBoards(k), boardContext: (v: string) => api.jiraBoardContext(v) };
