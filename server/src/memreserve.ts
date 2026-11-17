/*
 * THE MEMORY RESERVE, ALL THE WAY UP.
 *
 * The desktop app sets MemoryLow on its own systemd scope at startup
 * (electron/memlow.js), so that under memory pressure the kernel takes pages
 * from every other cgroup first. Read on a real machine, that reserve was
 * honoured by nobody: in cgroup v2 a child's protection is capped by every
 * ancestor, and `user.slice`, `user-<uid>.slice` and `user@<uid>.service`
 * default to memory.low = 0. The scope said 1536M, the kernel used 0.
 * Measured with the ancestors at 0: the server's pages were swapped out and
 * the database's cached pages evicted, and reading them back held the
 * server's only thread for 2 to 4.5 s (server-stall.log, `swapin=` and
 * `diskblk=` on the stall lines, the thread in state D).
 *
 * Three of those levels belong to the system manager, so the app cannot set
 * them by itself: a person has to say yes once, with their password. This
 * module is the read (which levels hold the reserve), the two commands (one
 * polkit prompt for the three root levels, no prompt for the person's own
 * slices) and their undo. Nothing here runs unless the person pressed the
 * button in Settings: the route in index.ts is the only caller of `apply`.
 *
 * What made it work by hand, on the machine it was measured on:
 *   systemctl set-property user.slice MemoryLow=2G          (root)
 *   systemctl set-property user-<uid>.slice MemoryLow=2G    (root)
 *   systemctl set-property user@<uid>.service MemoryLow=2G  (root)
 *   systemctl --user set-property app.slice MemoryLow=2G    (no password)
 * Persistent here (no --runtime): a reserve that is gone after a reboot is a
 * setup step the person has to remember.
 */
import { existsSync, readFileSync } from "node:fs";
import { totalmem } from "node:os";
import type { MemoryReserveLevel, MemoryReserveReport, MemoryReserveResult } from "../../shared/memoryReserve.ts";
import { runChild } from "./broker/brokerRun.ts";

/** The same default electron/memlow.js sets on the app's own scope; a test reads both. */
export const DEFAULT_LOW = "1536M";

const SIZE = /^(\d+)([KMGT]?)$/i;
const UNIT_BYTES: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/**
 * How many bytes each level should hold, or null when the person switched the
 * reserve off (AGENTGLASS_MEMORY_LOW = 0, off, none, false) or wrote a size
 * systemd would not take, which electron/memlow.js treats the same way.
 *
 * Never more than a quarter of the machine's memory. memory.low is soft, but
 * on the three levels above the app it covers everything the person runs, so
 * a large value there shelters the whole session from reclaim: a quarter
 * leaves the kernel room on a small machine (on 4 GB, 1 GB and not 1536M).
 */
export function reserveBytes(override: string | undefined, ramBytes: number): number | null {
  const want = (override ?? "").trim();
  if (/^(off|none|false)$/i.test(want) || want === "0") return null;
  const m = SIZE.exec(want || DEFAULT_LOW);
  if (!m) return null;
  const bytes = Number(m[1]) * UNIT_BYTES[m[2]!.toUpperCase()]!;
  const cap = Math.floor(ramBytes / 4);
  return Math.max(0, Math.min(bytes, cap > 0 ? cap : bytes));
}

const ROOT_UNIT = /^(user\.slice|user-\d+\.slice|user@\d+\.service)$/;
/** A unit name systemd made: no slash, no space, nothing a command line could misread. */
const SAFE_UNIT = /^[A-Za-z0-9@_.:\\-]+\.(slice|scope|service)$/;

/**
 * The units from the app's own up to `user.slice`, or null when this process
 * is not under a systemd user manager (cgroup v1, a container, a system
 * service, another init): there is then no chain this module knows how to set.
 */
export function reserveChain(cgroupText: string): string[] | null {
  const line = cgroupText.split("\n").find((l) => l.startsWith("0::"));
  if (!line) return null;
  const parts = line.slice(3).trim().split("/").filter(Boolean);
  if (parts[0] !== "user.slice" || !parts.some((p) => /^user@\d+\.service$/.test(p))) return null;
  if (!parts.every((p) => SAFE_UNIT.test(p))) return null;
  return parts.reverse();
}

/** Who can set a level: the three above the user manager are root's, the last one is the app's own. */
export function ownerOf(unit: string, index: number): MemoryReserveLevel["owner"] {
  if (ROOT_UNIT.test(unit)) return "root";
  return index === 0 ? "app" : "user";
}

/**
 * Whether the reserve is honoured, and which levels stop it.
 *
 * A level holds the reserve when its memory.low is at least `want`. One level
 * below that, anywhere in the chain, caps everything under it, so the answer
 * is "effective" only when none is missing. A level that could not be read
 * counts as missing: an unknown is not a reserve. `missing` is top first, the
 * order a person would fix them in.
 */
export function reserveVerdict(levels: readonly MemoryReserveLevel[], want: number): { state: "effective" | "missing"; missing: string[] } {
  const missing = levels.filter((l) => l.low === null || l.low < want).map((l) => l.unit).reverse();
  return { state: missing.length ? "missing" : "effective", missing };
}

/** memory.low as the kernel prints it: bytes, or `max`. */
export function parseLow(text: string | null): number | null {
  const t = (text ?? "").trim();
  if (t === "max") return Number.MAX_SAFE_INTEGER;
  return /^\d+$/.test(t) ? Number(t) : null;
}

export interface ReserveIo {
  platform: string;
  /** /proc/self/cgroup, or null. */
  cgroup: () => string | null;
  /** memory.low of the cgroup at that path under /sys/fs/cgroup, or null. */
  low: (cgroupPath: string) => string | null;
  /** Whether systemd is this machine's init. */
  systemd: () => boolean;
  ram: () => number;
  override: () => string | undefined;
}

const read = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };

export const REAL_RESERVE_IO: ReserveIo = {
  platform: process.platform,
  cgroup: () => read("/proc/self/cgroup"),
  low: (cgroupPath) => read(`/sys/fs/cgroup/${cgroupPath}/memory.low`),
  systemd: () => existsSync("/run/systemd/system"),
  ram: () => totalmem(),
  override: () => process.env.AGENTGLASS_MEMORY_LOW,
};

const na = (why: string): MemoryReserveReport => ({ state: "not-applicable", want: 0, levels: [], missing: [], why });

/** The report the Requirements page shows. A handful of tiny reads of kernel files; nothing is spawned. */
export function reserveReport(io: ReserveIo = REAL_RESERVE_IO): MemoryReserveReport {
  if (io.platform !== "linux") return na("Only Linux has this reserve.");
  if (!io.systemd()) return na("This machine does not run systemd, which is what holds the reserve.");
  const chain = reserveChain(io.cgroup() ?? "");
  if (!chain) return na("The app is not running under a systemd user session.");
  const want = reserveBytes(io.override(), io.ram());
  if (want === null || want === 0) return na("The reserve is switched off (AGENTGLASS_MEMORY_LOW).");
  // chain is own unit first; the cgroup path of level i is the top-down prefix that ends at it.
  const topDown = [...chain].reverse();
  const levels: MemoryReserveLevel[] = chain.map((unit, i) => ({
    unit,
    low: parseLow(io.low(topDown.slice(0, topDown.length - i).join("/"))),
    owner: ownerOf(unit, i),
  }));
  return { want, levels, why: "", ...reserveVerdict(levels, want) };
}

/**
 * The one command the person is asked a password for.
 *
 * `systemctl set-property` takes one unit, and three separate pkexec calls
 * are three password prompts. So one pkexec runs a fixed script over its
 * arguments. The script is a constant: the amount and the unit names are
 * passed as arguments and read as "$1" and "$@", never written into the
 * script's text, and both are checked before they get here (digits only; the
 * three unit shapes only). An array, handed to spawn as it is.
 */
export const ROOT_SCRIPT = 'v="$1"; shift; for u in "$@"; do systemctl set-property "$u" "MemoryLow=$v" || exit 1; done';

export function rootArgv(units: readonly string[], bytes: number): string[] | null {
  const mine = units.filter((u) => ROOT_UNIT.test(u));
  if (!mine.length || !Number.isSafeInteger(bytes) || bytes < 0) return null;
  return ["pkexec", "/bin/sh", "-c", ROOT_SCRIPT, "agentglass-memory-reserve", String(bytes), ...mine];
}

/** The person's own slices between the user manager and the app (`app.slice`): no password. One command each. */
export function userArgvs(levels: readonly MemoryReserveLevel[], bytes: number): string[][] {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return [];
  return levels.filter((l) => l.owner === "user" && SAFE_UNIT.test(l.unit)).reverse()
    .map((l) => ["systemctl", "--user", "set-property", l.unit, `MemoryLow=${bytes}`]);
}

export type Run = (argv: string[], timeoutMs: number) => Promise<{ code: number; err: string }>;

const realRun: Run = async (argv, timeoutMs) => {
  try {
    // Through the spawn broker: a fork of the server stalls every request.
    const r = await runChild(argv, { timeoutMs });
    if (r.code === null && r.error) return { code: 127, err: r.error };
    return { code: r.code ?? 1, err: r.stderr.trim().split("\n").pop() ?? "" };
  } catch (e) {
    return { code: 127, err: e instanceof Error ? e.message : String(e) };
  }
};

/** How long the password prompt may stay open before the request gives up. */
export const PROMPT_TIMEOUT_MS = 120_000;

/** What pkexec's exit code means to a person. 126: they closed the prompt. 127: no agent could ask, or it said no. */
export function promptRefusal(code: number, err: string): string {
  if (code === 126) return "The password prompt was closed, so nothing was changed.";
  if (code === 127) return `The system could not ask for your password (${err || "no polkit agent answered"}), so nothing was changed.`;
  return `The system refused the change${err ? `: ${err}` : "."}`;
}

/**
 * Set the reserve on every level the app does not own, or take it off again.
 *
 * Root's three first, in one prompt: if the person closes it, nothing has
 * changed anywhere. Then the person's own slices, which need no prompt. The
 * app's own unit is electron/memlow.js's, set at every start, and is left
 * alone. Undo writes MemoryLow=0 on the same units, which is what they held
 * before; ceiling: a machine whose administrator had set a reserve of their
 * own on those levels gets 0, not their value, back.
 */
export async function applyReserve(action: "apply" | "undo", io: ReserveIo = REAL_RESERVE_IO, run: Run = realRun, pkexec: string | null = Bun.which("pkexec")): Promise<MemoryReserveResult> {
  const before = reserveReport(io);
  if (before.state === "not-applicable") return { ok: false, error: before.why, report: before };
  const bytes = action === "undo" ? 0 : before.want;
  const root = rootArgv(before.levels.map((l) => l.unit), bytes);
  if (!root) return { ok: false, error: "The session's own units could not be named, so nothing was changed.", report: before };
  if (!pkexec) return { ok: false, error: "pkexec (polkit) is not installed, so the app cannot ask for your password.", report: before };
  const asked = await run([pkexec, ...root.slice(1)], PROMPT_TIMEOUT_MS);
  if (asked.code !== 0) return { ok: false, error: promptRefusal(asked.code, asked.err), report: reserveReport(io) };
  for (const argv of userArgvs(before.levels, bytes)) {
    const r = await run(argv, 10_000);
    if (r.code !== 0) return { ok: false, error: `${argv[3]} was not changed${r.err ? `: ${r.err}` : "."}`, report: reserveReport(io) };
  }
  return { ok: true, report: reserveReport(io) };
}
