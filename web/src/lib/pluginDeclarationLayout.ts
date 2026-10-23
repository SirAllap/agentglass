import type { SandboxGrant } from "../../../shared/pluginSandbox.ts";

/** A long list shows this many chips, then folds behind "+n more". Eleven read
 *  paths in one column pushed the approve button off the screen; eight chips
 *  wrapped are two or three lines. */
export const CHIP_FOLD = 8;

export type Chip = { text: string; secret?: string };

/** The chips a list shows now, and how many it hides. `all` shows everything. */
export function foldChips<T>(items: readonly T[], all: boolean, limit = CHIP_FOLD): { shown: T[]; hidden: number } {
  if (all || items.length <= limit) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, limit), hidden: items.length - limit };
}

/** `/home/me/.config/acme` → `~/.config/acme`, so a chip is the part that differs. The browser does not know the home directory, so without `home` any /home/x or /Users/x counts as it. */
export function homeShort(path: string, home?: string): string {
  if (home && home !== "/" && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  const m = /^\/home\/[^/]+(\/.*)?$/.exec(path) ?? /^\/Users\/[^/]+(\/.*)?$/.exec(path);
  return m ? `~${m[1] ?? ""}` : path;
}

export type SandboxSection = {
  key: "network" | "reads" | "writes" | "programs";
  label: string;
  /** Text for a one-line value; chips for a list. */
  value?: string;
  warn?: boolean;
  chips?: Chip[];
};

/** The sandbox block as labelled sections, in reading order, empty ones left out. */
export function sandboxSections(d: { internet: boolean; reads: SandboxGrant[]; writes: SandboxGrant[]; programs: string[] }, home?: string): SandboxSection[] {
  // A path that looks like a login goes first: the fold hides the tail, and a
  // consent gate must never hide the one entry that matters behind "+n more".
  const grants = (g: SandboxGrant[]): Chip[] => [...g]
    .sort((a, b) => Number(!!b.secret) - Number(!!a.secret))
    .map((x) => ({ text: homeShort(x.path, home), secret: x.secret ?? undefined }));
  const out: SandboxSection[] = [
    { key: "network", label: "Network", value: d.internet ? "any host on the internet" : "this app only", warn: d.internet },
  ];
  if (d.reads.length) out.push({ key: "reads", label: "Reads", chips: grants(d.reads) });
  if (d.writes.length) out.push({ key: "writes", label: "Writes", chips: grants(d.writes) });
  if (d.programs.length) out.push({ key: "programs", label: "Programs", chips: d.programs.map((text) => ({ text })) });
  return out;
}
