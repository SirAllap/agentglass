/*
 * The sidebar's Team row, for real: every person the project will accept a card for (`GET /jira/members`),
 * with 0 included, not just those already holding a loaded card. Asked once per project and kept for the
 * rest of this window (`cache`), so a second board of the same project, or the same board read again, costs
 * no request; a board that spans more than one project, or the request itself failing, falls back to the
 * card-derived list the sidebar always had, and says so.
 */
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { mergeTeam, teamOf, type TeamMember } from "./jiraTree.ts";

const cache = new Map<string, Promise<{ key: string; name: string; avatar?: string }[] | null>>();

function membersOf(project: string): Promise<{ key: string; name: string; avatar?: string }[] | null> {
  let p = cache.get(project);
  if (!p) {
    p = api.jiraMembers(project).then((r) => (r.ok ? (r.people ?? []).map((u) => ({ key: u.key, name: u.name, ...(u.avatar ? { avatar: u.avatar } : null) })) : null)).catch(() => null);
    cache.set(project, p);
  }
  return p;
}

export interface JiraTeamResult {
  /** The people on the cards the active view returns, most cards first: what the Assignee picker shows by default. */
  team: TeamMember[];
  /** The project's full roster, 0-card members included, for "Show everyone"; undefined while it is still being read or failed. */
  everyone: TeamMember[] | undefined;
  fellBack: boolean;
}

/**
 * `tasks` are the board's own loaded cards (for the per-person count and the card-derived fallback);
 * `project` is their one project key, or null when the board spans none or more than one.
 */
export function useJiraTeam(tasks: readonly { assignees: readonly string[]; people?: readonly { key?: string; name: string; avatar?: string }[] }[], project: string | null, enabled: boolean): JiraTeamResult {
  const cardTeam = teamOf(tasks);
  const [members, setMembers] = useState<{ key: string; name: string; avatar?: string }[] | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !project) { setMembers(undefined); return; }
    let alive = true;
    setMembers(undefined);
    void membersOf(project).then((m) => { if (alive) setMembers(m); });
    return () => { alive = false; };
  }, [enabled, project]);
  if (!enabled || !project) return { team: cardTeam, everyone: undefined, fellBack: enabled && tasks.length > 0 };
  if (members === undefined) return { team: cardTeam, everyone: undefined, fellBack: false }; // still asking; no verdict yet
  if (members === null) return { team: cardTeam, everyone: undefined, fellBack: true }; // the request failed
  return { team: cardTeam, everyone: mergeTeam(members, cardTeam), fellBack: false };
}

/** A project opened once stays cached for the rest of this window; tests clear it between runs. */
export function __clearJiraTeamCache(): void { cache.clear(); }
