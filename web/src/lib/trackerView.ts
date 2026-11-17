/*
 * Which tracker owns the card a screen is looking at, for the screens that
 * decide it (the pull-request chip, the merge form, the terminal's card chip).
 *
 * `useOwnerSetup` hands those screens the ClickUp setup they already read, with
 * one extra function on it when Jira is connected. When it is not, it hands
 * back the very same object, and `chipAction` / `mergeCardRef` take the branch
 * they always took with the arguments they always had. That is the whole reason
 * for the shape: a ClickUp-only machine has nothing to differ in, and Jira
 * being connected is the only thing that turns the new path on.
 *
 * The repository's choice is read once and held for a minute, like the setup
 * beside it; saving a choice in Settings writes it through, so the next screen
 * to ask has the new answer without waiting.
 *
 * Ceiling: the choice is keyed by `owner/name`. A screen with no repository to
 * name (the terminal's branch chip knows a checkout, not a remote) asks with
 * "auto", and only the prefix decides there.
 */
import { useEffect, useMemo, useState } from "react";
import type { TrackerChoice } from "../../../shared/providers.ts";
import { api } from "./api.ts";
import type { CardOwner, CardRef, RefSetup } from "./cardRef.ts";
import { trackerFor } from "./trackerApi.ts";
import { trackerSetup, type TrackerSetup } from "./trackerSetup.ts";

export interface TrackerView {
  setup: TrackerSetup;
  choice: TrackerChoice;
  /** The repository's ClickUp-writes switch: off until somebody turns it on,
   *  and absent reads as off. A fallback tracker is read-only without it (see
   *  `clickupReadOnly`). */
  writesOn?: boolean;
}

type Choices = Record<string, Exclude<TrackerChoice, "auto">>;
type Writes = Record<string, true>;
const TTL = 60_000;
let held: { at: number; value: { choices: Choices; writes: Writes } } | null = null;
let inflight: Promise<{ choices: Choices; writes: Writes }> | null = null;

/** Both answers come in one read, so a screen asking for either never
 *  fetches twice. A failed read is "auto everywhere, writes off", and is not
 *  kept: the next ask tries again. */
function load(): Promise<{ choices: Choices; writes: Writes }> {
  if (held && Date.now() - held.at < TTL) return Promise.resolve(held.value);
  inflight ??= api.trackerProjects()
    .then((r) => {
      const value = { choices: r.projects ?? {}, writes: r.clickupWrites ?? {} };
      if (r.ok) held = { at: Date.now(), value };
      return value;
    })
    .catch(() => ({ choices: {}, writes: {} }))
    .finally(() => { inflight = null; });
  return inflight;
}

export function trackerChoices(): Promise<Choices> {
  return load().then((a) => a.choices);
}

/** The repositories whose ClickUp writes were turned back on. */
export function clickupWrites(): Promise<Writes> {
  return load().then((a) => a.writes);
}

/** Settings calls this after a save so the next reader sees it at once. */
export function rememberClickupWrites(value: Writes): void {
  held = { at: Date.now(), value: { choices: held?.value.choices ?? {}, writes: value } };
}

/** The same, for a saved tracker choice. */
export function rememberTrackerChoices(value: Choices): void {
  held = { at: Date.now(), value: { choices: value, writes: held?.value.writes ?? {} } };
}
export function __forgetTrackerChoices(): void { held = null; inflight = null; }

/** The choice for one repository; "auto" for none, or for one never chosen. */
export const choiceFor = (all: Choices, repo: string | undefined): TrackerChoice =>
  (repo && all[repo.toLowerCase()]) || "auto";

/** Whether ClickUp writes are turned back on for one repository; off for none,
 *  and off for one that was never turned on. */
export const clickupWritesOn = (all: Writes, repo: string | undefined): boolean =>
  !!(repo && all[repo.toLowerCase()]);

/**
 * One row of Settings > Card tracker: the repository and both values in force
 * for it.
 *
 * Absence is a value — Auto, Read-only — and the row says it, because a blank
 * where a default applies reads as "not set" rather than as what happens. The
 * order is the server's (the open project's own repository first), not the
 * alphabet's, and two spellings of one repository are one row.
 */
export function trackerRows(repos: readonly string[], choices: Choices, writes: Writes): { repo: string; tracker: TrackerChoice; writesOn: boolean }[] {
  const out: { repo: string; tracker: TrackerChoice; writesOn: boolean }[] = [];
  const seen = new Set<string>();
  for (const repo of repos) {
    const key = repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo, tracker: choiceFor(choices, repo), writesOn: clickupWritesOn(writes, repo) });
  }
  return out;
}

/**
 * Null unless Jira is connected: the old path, untouched.
 *
 * Asked by every card chip on screen, so it must cost a machine without Jira
 * nothing it could notice: the setup read is the one already held for a minute,
 * and a "no" is stored as null, which React sees as no change and does not
 * redraw for.
 */
export function useTrackerView(repo?: string): TrackerView | null {
  const [setup, setSetup] = useState<TrackerSetup | null>(null);
  const [all, setAll] = useState<{ choices: Choices; writes: Writes } | null>(null);
  useEffect(() => {
    let live = true;
    void trackerSetup().then((v) => { if (live) setSetup(v.jira ? v : null); });
    return () => { live = false; };
  }, []);
  const hasJira = !!setup;
  useEffect(() => {
    if (!hasJira) return;
    let live = true;
    // Both are one read; asking for either first never fetches twice.
    void Promise.all([trackerChoices(), clickupWrites()])
      .then(([choices, writes]) => { if (live) setAll({ choices, writes }); });
    return () => { live = false; };
  }, [hasJira]);
  return useMemo(
    () => (setup && all
      ? { setup, choice: choiceFor(all.choices, repo), writesOn: clickupWritesOn(all.writes, repo) }
      : null),
    [setup, all, repo],
  );
}

/**
 * The ClickUp setup with ownership attached, for the readers that decide whose
 * card an id is. It IS the setup, the same object, until Jira is connected: a
 * machine without Jira gets back exactly what it passed in, so every reader
 * below it takes the branch it always took. Only with Jira present does it
 * carry `ownerOf`, which they then ask instead of `looksLikeOurs`.
 */
export function ownerSetup<S extends RefSetup>(setup: S | null, view: TrackerView | null): (S & Pick<RefSetup, "ownerOf" | "jira">) | null {
  if (!view || !setup) return setup;
  return {
    ...setup,
    ownerOf: (ref: CardRef, whenUnknown: boolean): CardOwner => ({
      owner: trackerFor(ref, view.setup, view.choice, { whenUnknown, noCustomIds: setup.noCustomIds })?.id ?? null,
      jiraSite: view.setup.jira?.site,
    }),
    ...(view.setup.jira ? { jira: { keys: view.setup.jira.prefixes, site: view.setup.jira.site } } : null),
  };
}

export function useOwnerSetup<S extends RefSetup>(setup: S | null, repo?: string): (S & Pick<RefSetup, "ownerOf" | "jira">) | null {
  const view = useTrackerView(repo);
  return useMemo(() => ownerSetup(setup, view), [setup, view]);
}
