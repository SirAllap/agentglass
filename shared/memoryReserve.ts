/**
 * What the Requirements page is told about the memory reserve.
 *
 * `levels` runs from the app's own unit up to `user.slice`, the order the
 * kernel applies them in reverse: a level's reserve is capped by every level
 * above it.
 */
export interface MemoryReserveLevel {
  /** The systemd unit, as the cgroup path names it. */
  unit: string;
  /** Its memory.low in bytes; null when the file could not be read. */
  low: number | null;
  /** Who can set it: the system manager (a password) or the person's own. */
  owner: "root" | "user" | "app";
}

export type MemoryReserveState =
  /** Every level holds the reserve: the kernel honours it. */
  | "effective"
  /** At least one level holds less: named in `missing`. */
  | "missing"
  /** Not Linux, no systemd user manager, or switched off by the person. */
  | "not-applicable";

export interface MemoryReserveReport {
  state: MemoryReserveState;
  /** Bytes each level should hold. 0 when not applicable. */
  want: number;
  levels: MemoryReserveLevel[];
  /** Units that hold less than `want`, top first. */
  missing: string[];
  /** Why it is not applicable, in a sentence. Empty otherwise. */
  why: string;
}

export interface MemoryReserveResult {
  ok: boolean;
  error?: string;
  report: MemoryReserveReport;
}
