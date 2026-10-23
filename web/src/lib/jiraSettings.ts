/*
 * The Jira settings this window has read: the write switch and the hand-off
 * per project. Local to the app (no request to Jira), read once and shared by
 * every button that asks, and replaced in place when the settings row saves,
 * so a changed hand-off shows on the card without a reload.
 */
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { JiraHandoffRule, JiraSettings } from "../../../shared/providers.ts";

let held: JiraSettings | null = null;
let asking: Promise<JiraSettings | null> | null = null;
const subs = new Set<(s: JiraSettings | null) => void>();

export function loadJiraSettings(): Promise<JiraSettings | null> {
  if (held) return Promise.resolve(held);
  asking ??= api.jiraSettings()
    .then((r) => (r?.ok ? { writes: !!r.writes, handoff: r.handoff ?? {} } : null))
    .catch(() => null)
    .then((s) => { asking = null; if (s) noteJiraSettings(s); return s; });
  return asking;
}

/** What the settings row saved, or the server answered: every reader redraws from it. */
export function noteJiraSettings(s: JiraSettings): void {
  held = s;
  for (const f of subs) f(s);
}

export function useJiraSettings(): JiraSettings | null {
  const [s, setS] = useState<JiraSettings | null>(held);
  useEffect(() => {
    subs.add(setS);
    void loadJiraSettings();
    return () => { subs.delete(setS); };
  }, []);
  return s;
}

/** The project a Jira card belongs to: the key the site gave it, or the part of its id before the number. */
export function projectOf(t: { listId?: string; customId?: string; id: string }): string {
  if (t.listId) return t.listId;
  const k = t.customId || t.id;
  const i = k.lastIndexOf("-");
  return i > 0 ? k.slice(0, i).toUpperCase() : "";
}

export const ruleFor = (s: JiraSettings | null, project: string): JiraHandoffRule | undefined => s?.handoff[project];

/** Test seam: the module keeps what it read for the window's life. */
export function __forgetJiraSettings(): void { held = null; asking = null; }
