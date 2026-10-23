/*
 * Folders for the Machine tab's columns, read a page at a time.
 *
 * Measured with 100,000 entries: the first 128 rows answer in 15 ms and the
 * whole folder in about 100 ms of server time. What makes a folder that size
 * feel instant is therefore not speed but order — show the first page at once,
 * keep reading behind it, and let a newer question about the same folder cancel
 * the older one so the slow answer to a refresh cannot overwrite the fast one.
 *
 * The first page is small (128) because it is the one somebody waits for; the
 * rest are as large as the server allows (512) because by then they are only
 * throughput. Listener calls are throttled: 100,000 rows arriving in 196 pages
 * must not become 196 renders.
 */
import type { BrowsePage } from "../../../shared/types.ts";
import type { Row } from "./finderMiller.ts";

export const FIRST_PAGE = 128;
export const NEXT_PAGE = 512;

export type Fetcher = (path: string, cursor: number, hidden: boolean, limit: number, signal: AbortSignal) => Promise<BrowsePage>;

export interface FolderState {
  rows: Row[];
  /** What the folder holds after the hidden rule: known from the first page, before the rows are. */
  total: number;
  /** Every page has arrived, or the read stopped on an error. */
  done: boolean;
  error: string | null;
  hiddenSkipped: number;
  hidden: boolean;
}

interface Slot { state: FolderState; abort: AbortController }

export class FolderStore {
  private slots = new Map<string, Slot>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dead = false;

  constructor(
    private fetchPage: Fetcher,
    private onChange: () => void,
    private throttleMs = 120,
    private keep = 24,
  ) {}

  get(path: string): FolderState | undefined { return this.slots.get(path)?.state; }

  /** Read `path`, unless it is already read (or being read) the same way and `force` is not set. */
  load(path: string, hidden: boolean, force = false): void {
    if (this.dead) return;
    const have = this.slots.get(path);
    if (have && have.state.hidden === hidden && !force) { this.touch(path, have); return; }
    have?.abort.abort();
    const abort = new AbortController();
    const slot: Slot = { state: { rows: [], total: 0, done: false, error: null, hiddenSkipped: 0, hidden }, abort };
    this.touch(path, slot);
    while (this.slots.size > this.keep) {
      const oldest = this.slots.keys().next().value as string;
      this.slots.get(oldest)?.abort.abort();
      this.slots.delete(oldest);
    }
    void this.run(path, slot);
  }

  private touch(path: string, slot: Slot) { this.slots.delete(path); this.slots.set(path, slot); }

  private async run(path: string, slot: Slot): Promise<void> {
    const s = slot.state;
    let cursor: number | null = 0;
    try {
      while (cursor !== null) {
        const page = await this.fetchPage(path, cursor, s.hidden, cursor === 0 ? FIRST_PAGE : NEXT_PAGE, slot.abort.signal);
        if (slot.abort.signal.aborted || this.dead) return;
        if (!page.ok) { s.error = page.error ?? "could not read this folder"; break; }
        s.rows = cursor === 0 ? page.entries : s.rows.concat(page.entries);
        s.total = page.total;
        s.hiddenSkipped = page.hiddenSkipped;
        cursor = page.next;
        this.changed(cursor === null || s.rows.length <= FIRST_PAGE);
      }
    } catch {
      if (slot.abort.signal.aborted || this.dead) return;
      s.error = "could not read this folder";
    }
    s.done = true;
    this.changed(true);
  }

  private changed(now: boolean) {
    if (this.dead) return;
    if (now || this.throttleMs === 0) { if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.onChange(); return; }
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; if (!this.dead) this.onChange(); }, this.throttleMs);
  }

  dispose(): void {
    this.dead = true;
    if (this.timer) clearTimeout(this.timer);
    for (const s of this.slots.values()) s.abort.abort();
    this.slots.clear();
  }
}
