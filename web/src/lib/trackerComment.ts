/*
 * Commenting on a card, the same way for either tracker.
 *
 * ClickUp's is the call the card panel has always made, with the same body:
 * `api.clickupComment(id, text)`; its server finds the people named in the
 * text in the workspace's roster. Jira has no roster to read whole (people are
 * found by a search per query), so the composer sends who it offered and was
 * picked, by the id the search gave, and the server turns `@Name` into a real
 * mention only for them.
 *
 * A Jira comment can also answer another (`replyTo`, Cloud's thread); editing and
 * deleting your own is in the Jira card (components/jira/JiraActivity.tsx).
 * Ceiling: no resolve; that stays ClickUp's.
 */
import { api } from "./api.ts";
import { mentioned } from "./mentions.ts";
import type { ProviderTask, TaskDetail } from "../../../shared/providers.ts";

export interface CommentMention { id: string; name: string }
export interface CommentResult {
  ok: boolean; error?: string; unauthorised?: boolean;
  /** The card as it is after the comment, re-read. */
  task?: ProviderTask;
  /** Jira answers with the card's thread too, so the panel needs no second read. */
  detail?: TaskDetail; more?: number;
  /** Posted, but something after it failed: a warning, never plain success. */
  partial?: string;
}

const UNREACHABLE = "Could not reach the server";

export async function clickupComment(task: ProviderTask, markdown: string): Promise<CommentResult> {
  try {
    return await api.clickupComment(task.id, markdown);
  } catch { return { ok: false, error: UNREACHABLE }; }
}

export async function jiraComment(task: ProviderTask, markdown: string, mentions: CommentMention[] = [], replyTo?: string): Promise<CommentResult> {
  try {
    const r = await api.jiraComment(task.customId ?? task.id, markdown, mentions, replyTo);
    return { ok: r.ok, error: r.error, unauthorised: r.unauthorised, task: r.task, detail: r.detail, more: r.more, partial: r.partial };
  } catch { return { ok: false, error: UNREACHABLE }; }
}

/** Somebody the people search offered, and the id a mention of them carries. */
export interface OfferedPerson { key: string; name: string; initials?: string; avatar?: string }

/**
 * Who the text names, among everybody offered while it was written. The
 * composer's menu numbers its rows, so each person gets a number the first
 * time they are offered and keeps it; `mentioned` does the matching, the same
 * rule the ClickUp box uses (longest name first, a word edge after it).
 */
export class OfferedPeople {
  private byKey = new Map<string, OfferedPerson & { id: number }>();
  /** Remember these and answer them as rows the composer can draw. */
  add(people: OfferedPerson[]): (OfferedPerson & { id: number })[] {
    return people.map((p) => {
      const had = this.byKey.get(p.key);
      const row = { ...p, id: had?.id ?? this.byKey.size + 1 };
      this.byKey.set(p.key, row);
      return row;
    });
  }
  /** The people `text` names, as the server takes them. */
  named(text: string): CommentMention[] {
    return mentioned(text, [...this.byKey.values()]).map((p) => ({ id: p.key, name: p.name }));
  }
}
