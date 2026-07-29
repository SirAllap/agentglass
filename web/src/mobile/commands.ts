import type { ProjectCommand, TerminalCommands } from "../../../shared/types.ts";

/**
 * A project's own commands, on a device with no terminal.
 *
 * `/terminal/commands` reads the Makefile targets and the package.json scripts
 * of every directory in a checkout, with the comment above each target as its
 * description. The cockpit puts them above the shell as one-tap buttons. The
 * phone never asked for them, because a phone has no shell to put them above —
 * and that is the wrong conclusion. What a phone has is an agent, and "run the
 * suite and tell me what broke" is a better use of one than typing it out.
 *
 * So the action is a hand-off, not an execution: it opens a conversation in
 * that directory with the command in the prompt. Nothing runs behind your back,
 * and what does run is something you can watch and interrupt — which is the
 * only kind of remote execution worth having from a pocket.
 */

export interface CommandRow extends ProjectCommand {
  /** Where it came from, for the eyebrow. */
  kind: "make" | "script";
  /** Stable across a re-fetch, and unique per command. */
  key: string;
}

/**
 * Every command, in a reading order.
 *
 * `make test` and `npm run test` are two different commands that happen to
 * share a name, and both belong on the list — a project with a Makefile
 * wrapping its scripts is the common case, and hiding one of them means the
 * list quietly disagrees with the repository. Deduplication is on the command
 * itself plus its directory, which is what actually identifies it.
 *
 * Root first, then by directory, so a monorepo reads top-down instead of
 * interleaving four packages' `build` scripts.
 */
export function commandRows(tc: TerminalCommands | null | undefined): CommandRow[] {
  if (!tc) return [];
  const rows: CommandRow[] = [];
  const seen = new Set<string>();
  const take = (list: readonly ProjectCommand[] | undefined, kind: "make" | "script") => {
    for (const c of list ?? []) {
      if (!c?.cmd?.trim()) continue;
      // A separator that cannot occur in either half. A space would do until a
      // Makefile has a target with one in it, which is legal and rare enough
      // that the bug would be found by somebody else.
      const key = `${c.dir}\u0000${c.cmd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...c, kind, key });
    }
  };
  // Make first: a Makefile target is usually the intended entry point, and the
  // scripts under it are the implementation.
  take(tc.make, "make");
  take(tc.scripts, "script");
  // Directory, then make before scripts, then name. Sorting by name alone
  // discarded the make-first intent above, which is the point of collecting
  // them in that order in the first place.
  //
  // The root needs no special case: "" sorts before every other string, so it
  // is first for free. An earlier version spelled that out with a ternary,
  // which no mutation could break — dead code dressed as care.
  return rows.sort((a, b) =>
    a.dir.localeCompare(b.dir) ||
    (a.kind === b.kind ? 0 : a.kind === "make" ? -1 : 1) ||
    a.name.localeCompare(b.name));
}

/**
 * What to ask the agent.
 *
 * The command verbatim, because paraphrasing it is how you end up running
 * something else. The description when there is one, because a target called
 * `up` means nothing out of context and the agent has no more idea than you do.
 */
export function promptFor(c: ProjectCommand): string {
  const where = c.dir ? ` in ${c.dir}` : "";
  const why = c.desc?.trim() ? `\n\nWhat it does: ${c.desc.trim()}` : "";
  return `Run \`${c.cmd}\`${where} and tell me what happened. ` +
    `If it fails, show me the part of the output that explains why.${why}`;
}

/** Why there is nothing to show, in a sentence — the three cases are different
 *  and an empty list said the same thing about all of them. */
export function commandsEmpty(tc: TerminalCommands | null | undefined): string | null {
  if (!tc) return "Still reading the project";
  if (!tc.enabled) {
    return tc.reason === "windows" ? "The shell backend does not run on this host"
      : tc.reason === "env" ? "The terminal is switched off on this server"
      : "The terminal is not available on this server";
  }
  if (commandRows(tc).length) return null;
  return "No Makefile targets and no package.json scripts in this checkout";
}
