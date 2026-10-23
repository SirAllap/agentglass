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
}

type Choices = Record<string, Exclude<TrackerChoice, "auto">>;
const TTL = 60_000;
let held: { at: number; value: Choices } | null = null;
let inflight: Promise<Choices> | null = null;

export function trackerChoices(): Promise<Choices> {
  if (held && Date.now() - held.at < TTL) return Promise.resolve(held.value);
  // A failed read is "auto everywhere", and is not kept: the next ask tries again.
  inflight ??= api.trackerProjects()
    .then((r) => { const value = r.projects ?? {}; if (r.ok) held = { at: Date.now(), value }; return value; })
    .catch(() => ({} as Choices))
    .finally(() => { inflight = null; });
  return inflight;
}

/** Settings calls this after a save so the next reader sees it at once. */
export function rememberTrackerChoices(value: Choices): void { held = { at: Date.now(), value }; }
export function __forgetTrackerChoices(): void { held = null; inflight = null; }

/** The choice for one repository; "auto" for none, or for one never chosen. */
export const choiceFor = (all: Choices, repo: string | undefined): TrackerChoice =>
  (repo && all[repo.toLowerCase()]) || "auto";

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
  const [all, setAll] = useState<Choices | null>(null);
  useEffect(() => {
    let live = true;
    void trackerSetup().then((v) => { if (live) setSetup(v.jira ? v : null); });
    return () => { live = false; };
  }, []);
  const hasJira = !!setup;
  useEffect(() => {
    if (!hasJira) return;
    let live = true;
    void trackerChoices().then((v) => { if (live) setAll(v); });
    return () => { live = false; };
  }, [hasJira]);
  return useMemo(
    () => (setup && all ? { setup, choice: choiceFor(all, repo) } : null),
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
