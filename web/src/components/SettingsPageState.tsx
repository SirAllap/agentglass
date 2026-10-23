import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { PageNeed, PageProblem } from "../lib/settingsNav.ts";
import { SAVED_MS, nextSavePhase, type SavePhase } from "../lib/settingsStates.ts";

/**
 * How a page tells the shell it is in trouble or mid-write.
 *
 * The nav's marks and the header's chips are read once when Settings opens
 * (`navMarks`); a page's own fetch failing a minute later is something only the
 * page knows. It says so here, the shell turns the page's nav dot red and puts
 * a red chip and a "Try again" in the header, and takes them away when the page
 * stops saying so (or unmounts). Outside the shell (a test, a storybook) there
 * is no sink and both hooks do nothing.
 */
export interface PageStateSink {
  problem: (page: string, p: PageProblem | null, retry?: () => void) => void;
  saving: (page: string, on: boolean) => void;
  /** The page found something only the person can do; `null` clears it. */
  needs: (page: string, n: PageNeed | null) => void;
}
export const PageState = createContext<PageStateSink | null>(null);

/** Report that `page` could not read what it shows; `null` clears it. `retry` is what the header's button runs. */
export function useReportProblem(page: string, p: PageProblem | null, retry?: () => void) {
  const sink = useContext(PageState);
  const retryRef = useRef(retry);
  retryRef.current = retry;
  const chip = p?.chip, title = p?.title;
  useEffect(() => {
    if (!sink || chip === undefined || title === undefined) return;
    sink.problem(page, { chip, title }, () => retryRef.current?.());
    return () => sink.problem(page, null);
  }, [sink, page, chip, title]);
}

/** Report what the person must do on `page` (count and one sentence saying what); the nav mark and header chip read it. */
export function useReportNeeds(page: string, n: PageNeed | null) {
  const sink = useContext(PageState);
  const count = n?.count, title = n?.title;
  useEffect(() => {
    if (!sink || count === undefined || title === undefined) return;
    sink.needs(page, { count, title });
    return () => sink.needs(page, null);
  }, [sink, page, count, title]);
}

/** Report that a write of `page` is out, for the header chip. */
export function useReportSaving(page: string, busy: boolean) {
  const sink = useContext(PageState);
  useEffect(() => {
    if (!sink || !busy) return;
    sink.saving(page, true);
    return () => sink.saving(page, false);
  }, [sink, page, busy]);
}

/**
 * Saving, then Saved for a moment, for a write whose own `busy` the page
 * already keeps. Also reports to the header while it is out.
 */
export function useSavePhase(page: string, busy: boolean, failed = false): SavePhase {
  const [phase, setPhase] = useState<SavePhase>("idle");
  useEffect(() => { setPhase((p) => nextSavePhase(p, busy, failed)); }, [busy, failed]);
  useEffect(() => {
    if (phase !== "saved") return;
    const t = setTimeout(() => setPhase("idle"), SAVED_MS);
    return () => clearTimeout(t);
  }, [phase]);
  useReportSaving(page, busy);
  return phase;
}
