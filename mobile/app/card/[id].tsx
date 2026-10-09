/*
 * One card, moved and handed over without opening ClickUp.
 *
 * The board's own words throughout. Status names, status colours and list
 * names are printed exactly as the workspace spells them, because renaming
 * somebody's workflow is not ours to do and a board's colours are how its
 * people read it at a glance — the same rule tasks.tsx already states. What
 * this app decides for itself is only `statusKind`, since status NAMES are
 * per-list and a workspace may have four words for "doing".
 *
 * ── the two actions ──────────────────────────────────────────────────────
 * Move it, and hand it to Claude. Both need `full`: they write to somebody
 * else's workspace and to somebody else's machine, and a phone paired to
 * answer gates does not get either. The controls are not drawn rather than
 * drawn and refused, which is the rule repos.tsx set.
 *
 * ── the card has a body, and this screen used to drop it ─────────────────
 * `/clickup/task` answers with a whole TaskDetail — the description, the
 * subtasks, the checklists and every comment — and this screen kept the one
 * field the list rows already carry. It then explained the gap with a comment
 * saying a card has no description, which was true of `ProviderTask` and false
 * of what had just been fetched: the most expensive kind of wrong note, one
 * that reads as a reason and stops anybody looking.
 *
 * ── the hand-off asks two things, and this is the second ─────────────────
 * WHAT first, then WHERE. A card handed over used to carry one prompt — its id
 * and its title — which is the right default and is not what you want most of
 * the time: you have skills that take a card, and naming one is the difference
 * between "here is a card" and "fix this card". They are matched rather than
 * listed, in shared/cardSkills.ts, because a hand-kept list is wrong the first
 * time somebody writes another one.
 *
 * ── why the hand-off asks which checkout ─────────────────────────────────
 * A card is not a checkout. The desktop maps a ClickUp list to a local
 * repository with `rootForTask`, using where the panel is open as a hint —
 * neither of which a phone has. So it asks, once, in a sheet, and remembers
 * nothing: guessing wrong here opens an agent in the wrong project, which
 * looks exactly like the right one until it starts editing.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Linking, Pressable, ScrollView, Text, TextInput, View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import type { CardPr, ListMember, ProviderId, ProviderTask, TaskDetail } from "../../../shared/providers.ts";
import type { GitRepoRef, SkillInfo } from "../../../shared/types.ts";
import { ask, askCached } from "../../src/lib/api.ts";
import { announceCard } from "../../src/state/card-edits.ts";
import { AVATAR, Avatar, AvatarStack } from "../../src/Avatar.tsx";
import { Bubble, Rail } from "../../src/review/Bubble.tsx";
import { cardPrsQuery, needsFoundNote, prLine } from "../../src/model/cardPrs.ts";
import { noteCardPrs } from "../../src/state/card-links.ts";
import { CARD_FRESH_MS, LIST_FRESH_MS, cardKey, cards, lists, members, writes } from "../../src/state/card-cache.ts";
import { useAgentglass, PR_READ_TTL_MS } from "../../src/state/host-context.tsx";
import { Md, outline } from "../../src/md/Md.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { providerTitle } from "../../src/model/taskProviders.ts";
import { openLinkedPr } from "../../src/state/open-pr.ts";
import { requestHandoff } from "../../src/terminal/handoff.ts";
import { mainCheckouts } from "../../src/model/prRows.ts";
import { cardSkills, namedForIt, skillCommand, skillModes, windowName } from "../../../shared/cardSkills.ts";
import { dueIn, since } from "../../src/lib/dates.ts";
import { Btn, Card, Chip, Group, GroupTitle, Label, LabelChip, Note, Row, Sheet, SheetRow, TAP } from "../../src/ui.tsx";
import { FieldRow } from "../../src/cards/FieldRow.tsx";
import { AssigneeSheet } from "../../src/cards/AssigneeSheet.tsx";
import { Snackbar } from "../../src/cards/Snackbar.tsx";
import { StatusConflict } from "../../src/cards/StatusConflict.tsx";
import { StatusSheet } from "../../src/cards/StatusSheet.tsx";
import { commentAccess, conflictDialog, moveOutcome, statusAccess, statusInk, undoTarget, type ConflictDialog } from "../../src/model/cardStatus.ts";
import {
  appliedDiff, assigneeAccess, assigneeConflict, assigneeLine, currentIds, nameIn, summaryText, undoDiff, type AssigneeConflict, type Diff,
} from "../../src/model/cardAssignees.ts";
import { ChevronIcon, PrsIcon } from "../../src/nav/icons.tsx";
import { Glyph } from "../../src/nav/glyphs.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

/**
 * Where this card lives. Every route this screen reads is `/clickup/…`, so
 * this is the route's own name and not a guess — and it is spelled once, here,
 * so the button that opens the card in the tracker takes the catalogue's title
 * (`providerTitle`) rather than a word typed into JSX. A `ProviderTask` does
 * not carry its provider, which is why the screen has to say.
 */
const PROVIDER: ProviderId = "clickup";

/** GitHub's three states, in the colours this app already uses for them.
 *  Draft is grey rather than green: it is open and it is not asking to be
 *  merged, which is a different thing to a reader deciding if work is done. */
function prInk(pr: { state: string; draft?: boolean }): string {
  if (pr.draft) return C.text4;
  const state = (pr.state || "").toUpperCase();
  if (state === "MERGED") return C.primary;
  if (state === "CLOSED") return C.error;
  if (state === "OPEN") return C.success;
  // A pull request named by the card's own field is not searched for, so it
  // arrives with no state at all. Grey says "we did not ask" rather than
  // picking one of the three.
  return C.text4;
}

/** How much description opens by default. 900 is about a screenful and a half
 *  at this size — enough that most cards are shown whole and a specification is
 *  visibly cut rather than silently truncated. */
/** How much of a description shows before the fold. Blocks, not
 *  characters: a cut mid-sentence is a cut nobody chose. */
const BODY_BLOCKS = 5;

/** One status the card can be moved to, as the list defines it. */
interface Status { status: string; color?: string; type?: string }

export default function CardScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const mayWrite = host?.scope === "full";

  /* What was held from the last look, drawn at once while a read, if one is
     due, goes out — see state/card-cache.ts. */
  const held = host && id ? cards.get(cardKey(host.origin, id)) : null;
  const [card, setCard] = useState<ProviderTask | null>(held?.value.task ?? null);
  const [statuses, setStatuses] = useState<Status[]>(() => (card?.listId ? lists.get(card.listId)?.value ?? [] : []));
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  /** The last successful move: what it was on before, so "Undo" has
   *  somewhere to send it back to. Its own state rather than folded into
   *  `said`: it is the snackbar's, and it goes away with it. `undone` is the
   *  move Undo itself made, which is not undone in its turn. */
  const [moved, setMoved] = useState<{ from: string; to: string; undone?: boolean } | null>(null);
  /** The answer to "does the computer let ClickUp be written to", held per
   *  computer (see writes in card-cache.ts); null until it is known. */
  const [writeEnabled, setWriteEnabled] = useState<boolean | null>(() => (host ? writes.get(host.origin)?.value ?? null : null));
  const [choosing, setChoosing] = useState(false);
  /** The last successful change of assignees, for "Undo". Like `moved`, it
   *  goes away with the snackbar, and the change Undo itself made is not undone
   *  in its turn. */
  const [assigned, setAssigned] = useState<{ diff: Diff; undone?: boolean } | null>(null);
  const [assigning, setAssigning] = useState(false);
  /** Who the list offers; null while it is being read. */
  const [roster, setRoster] = useState<ListMember[] | null>(() => (host && card?.listId ? members.get(cardKey(host.origin, card.listId))?.value ?? null : null));
  const [rosterError, setRosterError] = useState<string | null>(null);
  /** Set when assignees were refused because the card changed underneath. */
  const [assignConflict, setAssignConflict] = useState<{ dialog: AssigneeConflict; diff: Diff; stamp: number } | null>(null);
  /** Set when a move was refused because the card changed underneath it. */
  const [conflict, setConflict] = useState<{ dialog: ConflictDialog; wanted: string; stamp: number } | null>(null);
  /** The height of the bar at the foot, so the snackbar sits above it. */
  const [barH, setBarH] = useState(76);
  const [busy, setBusy] = useState<string | null>(null);
  /** Everything on the card that is not the card's own row. Null until the
   *  first read lands — an empty description and "not read yet" are different
   *  things and the screen draws them differently. */
  const [detail, setDetail] = useState<Omit<TaskDetail, "task"> | null>(held ? {
    description: held.value.description ?? "",
    subtasks: held.value.subtasks ?? [],
    checklists: held.value.checklists ?? [],
    comments: held.value.comments ?? [],
  } : null);
  /** Whether the whole description is showing. A ClickUp description is often
   *  a specification, and a screen that opens on eight hundred words has
   *  buried the status and the buttons under them. */
  const [wholeBody, setWholeBody] = useState(false);
  /*
   * The pull requests that belong to this card.
   *
   * Its own call, and deliberately not part of the card read: `/clickup/prs`
   * shells out to `gh pr list --search`, which is seconds rather than
   * milliseconds and fails entirely on a machine with no GitHub CLI. Folding it
   * into the card read would make a card that cannot be seen at all because a
   * search for its number timed out.
   */
  const [prs, setPrs] = useState<CardPr[] | null>(null);
  const [handing, setHanding] = useState(false);
  /*
   * The skills that take a card, and which one was picked.
   *
   * Null until `/skills` answers; an empty array is a real answer and means
   * this machine has none that mention a card, which is worth saying rather
   * than showing an empty list. `picked` null means the old behaviour — the
   * card's id and title as the prompt — and it stays the first row, because it
   * is the right thing to send when you have not decided what to do yet.
   */
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<{ skill: SkillInfo; mode?: string } | null>(null);
  const [find, setFind] = useState("");
  const [say, setSay] = useState("");
  const [commenting, setCommenting] = useState(false);

  /*
   * `/clickup/task` answers with a whole TaskDetail and this screen used to
   * keep one field of it.
   *
   * The description, the subtasks, the checklists and the comments all arrived
   * in the same response and were dropped on the floor — and the screen then
   * carried a comment explaining that a card has no description, which was a
   * true statement about `ProviderTask` and a false one about what had just
   * been read. The board's own page was the only place to see any of it.
   */
  const load = useCallback(async (force = true): Promise<ProviderTask | null> => {
    if (!host || !id) return null;
    // Young enough to trust: drawn already, and a read is three requests and a
    // fourth per thread of replies.
    if (!force && cards.fresh(cardKey(host.origin, id), CARD_FRESH_MS)) return null;
    const answer = await ask<{ ok?: boolean; error?: string } & Partial<TaskDetail>>(
      host, `/clickup/task?id=${encodeURIComponent(id)}`,
    );
    if (!answer.ok) { setError(answer.error); return null; }
    if (!answer.value.task) {
      setError(answer.value.error || "That card could not be read.");
      return null;
    }
    setError(null);
    setDetail({
      description: answer.value.description ?? "",
      subtasks: answer.value.subtasks ?? [],
      checklists: answer.value.checklists ?? [],
      comments: answer.value.comments ?? [],
    });
    setCard(answer.value.task);
    cards.put(cardKey(host.origin, id), answer.value as TaskDetail);
    return answer.value.task;
  }, [host, id]);

  useEffect(() => { void load(false); }, [load]);

  /*
   * The statuses of the card's OWN list, not the board's.
   *
   * The board's statuses are the wrong set for a card that lives somewhere
   * else — moving it into one either 400s or, worse, lands it in a status that
   * means something different on its real list. tasks.tsx hit this and asks
   * the list; this asks the same way.
   */
  useEffect(() => {
    if (!host || !card?.listId) return;
    let gone = false;
    void (async () => {
      // A list's statuses almost never change: held ten minutes, and the two
      // requests a read costs are spent once per list, not once per card.
      if (lists.fresh(card.listId!, LIST_FRESH_MS)) { setStatuses(lists.get(card.listId!)!.value); return; }
      const answer = await ask<{ ok?: boolean; statuses?: Status[] }>(
        host, `/clickup/list?id=${encodeURIComponent(card.listId!)}`,
      );
      if (gone || !answer.ok) return;
      lists.put(card.listId!, answer.value.statuses ?? []);
      setStatuses(answer.value.statuses ?? []);
    })();
    return () => { gone = true; };
  }, [host, card?.listId]);

  // Whether the computer lets ClickUp be written to, asked once per computer:
  // the Cards tab has usually answered it already (writes in card-cache.ts).
  useEffect(() => {
    if (!host || host.scope !== "full") return;
    if (writes.fresh(host.origin, CARD_FRESH_MS)) { setWriteEnabled(writes.get(host.origin)!.value); return; }
    let gone = false;
    void (async () => {
      const answer = await ask<{ writeEnabled?: boolean }>(host, "/clickup/views");
      if (gone || !answer.ok) return;
      writes.put(host.origin, answer.value.writeEnabled === true);
      setWriteEnabled(answer.value.writeEnabled === true);
    })();
    return () => { gone = true; };
  }, [host]);

  // Only when there is something to hand it to.
  useEffect(() => {
    if (!host || !mayWrite) return;
    let gone = false;
    void (async () => {
      const answer = await askCached<{ repos: GitRepoRef[] }>(host, "/git/repos", PR_READ_TTL_MS);
      if (!gone && answer.ok) {
        setRepos(mainCheckouts(Array.isArray(answer.value.repos) ? answer.value.repos : []));
      }
    })();
    return () => { gone = true; };
  }, [host, mayWrite]);

  /**
   * The write routes answer with the card as it stands afterwards — re-read by
   * the server, not assumed — and this screen used to drop it and re-fetch.
   * The list behind this screen never heard either way, so going back showed
   * the old column until a pull-to-refresh. Now the returned card goes on
   * screen at once and out to whoever holds a list (state/card-edits.ts);
   * `load` still follows, for the description, comments and subtasks the
   * write route does not carry.
   */
  const landed = useCallback((task: ProviderTask | undefined): void => {
    if (!task) return;
    setCard(task);
    announceCard(task);
    // The held copy follows, or going back in would draw the old column.
    const key = host && id ? cardKey(host.origin, id) : "";
    const was = key ? cards.get(key) : null;
    if (was) cards.put(key, { ...was.value, task }, was.at);
  }, [host, id]);

  /**
   * Move the card, with the stamp it was read at. Two requests on the board:
   * the server re-reads the card to compare the stamp, then writes.
   *
   * `updated` rides along so the server's stale-write guard runs: two people
   * dragging one card to different columns must not both win. A refusal for
   * that reason is a 409, which `ask` reports as a failed answer with its
   * status — `moveOutcome` knows it — and the dialog it opens is how the
   * person decides between the other change and their own. `stamp` is the
   * one exception: "move it anyway" sends the stamp of the card as it was just
   * re-read, so it overwrites what the dialog described and nothing newer.
   */
  const move = useCallback(async (status: string, how: { stamp?: number; undo?: boolean } = {}): Promise<void> => {
    if (!host || !card) return;
    const from = card.status;
    setMoved(null);
    setAssigned(null);
    setSaid(null);
    setBusy("move");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const answer = await ask<{ ok: boolean; error?: string; conflict?: boolean; task?: ProviderTask }>(
      host, "/clickup/status", { method: "POST", body: { id: card.id, status, updated: how.stamp ?? card.updated } },
    );
    setBusy(null);
    const outcome = moveOutcome(answer);
    if (outcome.kind === "conflict") {
      // The card is read again: it is what the dialog describes, and what the
      // screen should show whichever button is pressed.
      const theirs = await load();
      if (!theirs) { setSaid({ ok: false, text: "The card changed on the board while this was open — reopen it and try again." }); return; }
      setConflict({ dialog: conflictDialog({ theirs, opened: from, wanted: status, now: Date.now() }), wanted: status, stamp: theirs.updated });
      return;
    }
    if (outcome.kind === "failed") { setSaid({ ok: false, text: outcome.text }); return; }
    landed(outcome.task);
    setMoved({ from, to: status, undone: how.undo });
    // The write answered with the card as it stands; the description and the
    // comments did not change, so they are not read again (3 requests + 1 per
    // thread). Only an answer with no card falls back to a read.
    if (!outcome.task) await load();
  }, [host, card, load, landed]);

  /**
   * A note on the card's activity.
   *
   * No `updated` stamp is sent, and the server's own comment says why: a
   * comment adds to the history rather than overwriting a field, so a card
   * that moved underneath is not a reason to refuse this one. That is the
   * opposite of `move` above, which sends the stamp because two people
   * dragging one card to different columns must not both win.
   */
  const comment = useCallback(async (): Promise<void> => {
    if (!host || !card || !say.trim()) return;
    setBusy("comment");
    const answer = await ask<{ ok: boolean; error?: string }>(host, "/clickup/comment", {
      method: "POST",
      body: { id: card.id, text: say.trim() },
    });
    setBusy(null);
    if (!answer.ok) { setSaid({ ok: false, text: answer.error }); return; }
    if (!answer.value.ok) {
      setSaid({ ok: false, text: answer.value.error ?? "The board refused that." });
      return;
    }
    setSay("");
    setSaid({ ok: true, text: "Posted to the card." });
    await load();
  }, [host, card, say, load]);

  /**
   * Put people on the card and take people off it, as one write: two requests
   * on the board (the stale-write guard, then the change), and the answer is
   * the card, so nothing is re-read.
   *
   * `/clickup/card` takes `add` and `rem` together because the stamp is the
   * precondition and the first write moves it: two calls in a row would have
   * the second refused by the first. A refusal is a 409, which `moveOutcome`
   * reads from the status; the dialog it opens is how the person decides
   * between the other change and this one. `stamp` is the one exception: "apply
   * anyway" sends the stamp of the card as it was just re-read, so it
   * overwrites what the dialog described and nothing newer. The ids are
   * relative (add these, remove those), so applying them over the other
   * person's card does what the dialog said and no more.
   */
  const apply = useCallback(async (diff: Diff, how: { stamp?: number; undo?: boolean } = {}): Promise<void> => {
    if (!host || !card) return;
    setMoved(null);
    setAssigned(null);
    setSaid(null);
    setBusy("assign");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const answer = await ask<{ ok: boolean; error?: string; conflict?: boolean; task?: ProviderTask }>(host, "/clickup/card", {
      method: "POST",
      body: { id: card.id, updated: how.stamp ?? card.updated, add: diff.add, rem: diff.rem },
    });
    setBusy(null);
    const outcome = moveOutcome(answer);
    if (outcome.kind === "conflict") {
      const theirs = await load();
      if (!theirs) { setSaid({ ok: false, text: "The card changed on the board while this was open — reopen it and try again." }); return; }
      const known = [...(roster ?? []), ...(card.people ?? []), ...(theirs.people ?? [])];
      setAssignConflict({
        dialog: assigneeConflict({ theirs, diff, nameOf: (n) => nameIn(known, n), now: Date.now() }),
        diff,
        stamp: theirs.updated,
      });
      return;
    }
    if (outcome.kind === "failed") { setSaid({ ok: false, text: outcome.text }); return; }
    landed(outcome.task);
    // After "Apply anyway" `card` is the re-read one: Undo gets only this write's share.
    setAssigned({ diff: how.stamp ? appliedDiff(diff, card.people) : diff, undone: how.undo });
    if (!outcome.task) await load(); // see `move`: the write carried the card
  }, [host, card, roster, load, landed]);

  /**
   * Who the sheet lists: the card's list's members, asked for when the sheet
   * opens (not with the card: most cards are never re-assigned) and held ten
   * minutes per list. Two requests on the board.
   */
  const readRoster = useCallback(async (force = false): Promise<void> => {
    if (!host || !card?.listId) return;
    const key = cardKey(host.origin, card.listId);
    setRosterError(null);
    if (!force && members.fresh(key, LIST_FRESH_MS)) { setRoster(members.get(key)!.value); return; }
    const answer = await ask<{ ok?: boolean; error?: string; members?: ListMember[] }>(
      host, `/clickup/members?list=${encodeURIComponent(card.listId)}`,
    );
    if (!answer.ok) { setRosterError(answer.error); return; }
    if (!answer.value.ok) { setRosterError(answer.value.error ?? "The board would not say who is on the team."); return; }
    members.put(key, answer.value.members ?? []);
    setRoster(answer.value.members ?? []);
  }, [host, card?.listId]);

  /* After the card, and only once it has an id to search for. A failure is
     left as an empty list rather than an error on the screen: "no pull request
     mentions this card" and "GitHub could not be asked" look the same to a
     reader, so the section simply does not appear, and the card is still
     readable on a machine with no `gh`. */
  // The query, not the card: a reload, a write or a comment hands over a new
  // card object that asks the same question, and each one was a GitHub search.
  const cardId = card?.id;
  const prsQuery = card ? cardPrsQuery(card, repos) : null;
  useEffect(() => {
    if (!host || !cardId || prsQuery === null) return;
    let gone = false;
    void (async () => {
      const answer = await ask<{ ok: boolean; prs?: CardPr[] }>(host, `/clickup/prs?${prsQuery}`);
      if (gone) return;
      setPrs(answer.ok ? answer.value.prs ?? [] : []);
      // Only a real answer: a failed search is "not known", not "none".
      if (answer.ok) noteCardPrs(host, cardId, (answer.value.prs ?? []).length);
    })();
    return () => { gone = true; };
  }, [host, cardId, prsQuery]);

  /* Asked once the card is on screen, not on opening the sheet: the list is a
     hundred-odd entries on a real machine and filtering it is instant, but
     fetching it while somebody watches a sheet appear is a sheet that appears
     empty. A failure leaves it null and the sheet says so — the plain hand-off
     does not depend on this and stays available either way. */
  const hasCard = !!card;
  useEffect(() => {
    if (!hasCard || !host) return;
    let gone = false;
    void (async () => {
      const answer = await ask<{ skills?: SkillInfo[] }>(host, "/skills");
      if (gone) return;
      setSkills(answer.ok ? cardSkills(answer.value.skills ?? []) : null);
    })();
    return () => { gone = true; };
  }, [host, hasCard]);

  /**
   * Leave the window request and go to the terminal.
   *
   * The text is either the card — its id and its title, which is what the
   * desktop's own row hand-off sends — or a skill invoked on it. The id is the
   * HUMAN one in both cases, because that is what every skill, branch name and
   * commit message here is written against, and handing over the internal id
   * instead fails in the least useful way there is: the card exists and the
   * tool cannot find it.
   *
   * `skillCommand` is shared with the desk rather than spelled again here. The
   * shape of that line — `/name ID`, and a mode after it — is what the skills
   * were written against and what their own descriptions quote.
   */
  const hand = useCallback((repo: GitRepoRef): void => {
    // The terminal needs `full`; a phone without it is not offered this and,
    // if it gets here, does not go. See model/scope.ts.
    if (!card || !mayWrite) return;
    const label = card.customId || card.id;
    const command = picked
      ? `${skillCommand(picked.skill.name, card)}${picked.mode ? ` ${picked.mode}` : ""}`
      : `${label} — ${card.title}`;
    requestHandoff({
      t: "tmux",
      cmd: "issue",
      cwd: repo.root,
      name: windowName(card),
      prompt: command,
      agent: true,
      title: card.title,
    });
    setHanding(false);
    setPicking(false);
    router.push("/terminal");
  }, [card, picked, router, mayWrite]);

  /* The search, over name and description both — the same two fields the
     matcher itself reads, so a skill found by its description is findable by
     the same words here. */
  const shownSkills = useMemo(() => {
    const q = find.trim().toLowerCase();
    if (!q) return skills ?? [];
    return (skills ?? []).filter(
      (s) => s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
    );
  }, [skills, find]);

  /** The gears the picked skill advertises, if any. Read from its own
   *  invocation line rather than from a list kept here — see cardSkills.ts. */
  const pickedModes = useMemo(
    () => (picked ? skillModes(picked.skill.argument_hint) : []),
    [picked],
  );

  /* ClickUp writes an empty description as "" and sometimes as a lone newline,
     so the emptiness test is on the trimmed text and the trimmed text is what
     gets drawn. */
  const body = (detail?.description ?? "").trim();
  /* What the fold hides, named. A specification's next heading is the whole
     of what a reader needs to decide whether to open it. */
  const bodyRest = useMemo(() => outline(body, BODY_BLOCKS, true), [body]);

  /* Subtasks and checklist items counted as one number, because they are one
     question — what is left underneath this card. A subtask is done when the
     board says its status is done; a checklist item when it is ticked. */
  const under = useMemo(() => {
    const subs = detail?.subtasks ?? [];
    const items = (detail?.checklists ?? []).flatMap((c) => c.items);
    return {
      all: subs.length + items.length,
      left: subs.filter((t) => t.statusKind !== "done").length + items.filter((i) => !i.done).length,
    };
  }, [detail]);
  const allOver = under.all;
  const leftOver = under.left;

  const now = Date.now();

  const when = useMemo(() => (card ? dueIn(card.due, new Date()) : null), [card]);
  const access = statusAccess(host?.scope, writeEnabled);
  const assign = assigneeAccess(host?.scope, writeEnabled, card?.listId);
  const mayComment = commentAccess(host?.scope, writeEnabled);
  const moving = busy === "move";
  const assignBusy = busy === "assign";
  const undoPeople = undoDiff(assigned && !assigned.undone ? assigned.diff : null, currentIds(card?.people));
  const undo = undoTarget(moved && !moved.undone ? moved : null, card?.status ?? "");
  const snackDone = useCallback(() => { setMoved(null); setAssigned(null); }, []);
  const peopleKnown = [...(roster ?? []), ...(card?.people ?? [])];

  return (
    /* `padding`, both platforms, never Platform-conditional — the measurement
       is in test/keyboard-inset.test.ts. This screen takes typing now. */
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior="padding">
      <Stack.Screen options={{ title: card?.customId || card?.id || "Card" }} />

      <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl }}>
        {error ? (
          <Card>
            <Label text="Cannot read it" />
            <Note tone="bad">{error}</Note>
          </Card>
        ) : null}

        {!card && !error ? <ActivityIndicator color={C.text3} /> : null}

        {card ? (
          <>
            <View style={{ gap: 10, paddingHorizontal: SPACE.xs }}>
              <Text style={{ color: C.text, fontSize: T.head, fontWeight: "600", lineHeight: 26 }}>
                {card.title}
              </Text>
              {when || card.priority || card.tags.length ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                {when ? (
                  <Chip
                    label={when.late && when.text !== "today" ? when.text : `Due ${when.text}`}
                    tone={when.late ? "bad" : "warn"}
                    icon={<Glyph name="clock" color={when.late ? C.error : C.warning} size={14} />}
                  />
                ) : null}
                {card.priority ? <Chip label={card.priority[0]!.toUpperCase() + card.priority.slice(1)} /> : null}
                {card.tags.map((t) => <Chip key={t} label={t} />)}
              </View>
              ) : null}
            </View>

            {/*
              The card's fields, in one block whose rows keep their place in
              every state. Status is where a card is moved from, straight under
              what it is — it was a strip of chips below the description, a
              scroll away from the status it changed. A phone that may not
              write sees the same row with a lock where the chevron would be,
              and tapping it does nothing. Assignees is the row under Status, in
              the same slot: faces and every name, not a switch for yourself.
            */}
            <Group>
              <FieldRow
                label="Status"
                trail={moving ? "busy" : access.can ? "chevron" : access.why ? "lock" : null}
                onPress={access.can && statuses.length && !busy ? () => setChoosing(true) : undefined}
                accessibilityLabel={`Status, ${card.status}${access.why ? ", locked" : ""}`}
              >
                <LabelChip name={card.status} color={statusInk(card.statusColor)} />
              </FieldRow>
              <FieldRow
                label="Assignees"
                trail={assignBusy ? "busy" : assign.can ? "chevron" : assign.why ? "lock" : null}
                onPress={assign.can && !busy ? () => { setAssigning(true); void readRoster(); } : undefined}
                accessibilityLabel={`Assignees, ${assigneeLine(card)}${assign.why ? ", locked" : ""}`}
              >
                {card.people?.length ? <AvatarStack people={card.people} size={AVATAR.stack} /> : null}
                <Text
                  numberOfLines={2}
                  style={{
                    flex: 1, marginLeft: card.people?.length ? SPACE.sm : 0, fontSize: T.body,
                    color: card.people?.length || card.assignees.length ? C.text : C.text3,
                    fontWeight: card.people?.length || card.assignees.length ? "600" : "400",
                  }}
                >{assigneeLine(card)}</Text>
              </FieldRow>
              {card.list || card.sprint ? (
                <FieldRow label="List" trail={null}>
                  <Text numberOfLines={1} style={{ color: C.text, fontSize: T.body }}>
                    {[card.list, card.sprint].filter(Boolean).join(" · ")}
                  </Text>
                </FieldRow>
              ) : null}
            </Group>
            {assign.why ? <Note>{assign.why}</Note> : null}

            {said ? (
              <Note tone={said.ok ? "quiet" : "bad"}>{said.text}</Note>
            ) : null}

            {/* Rendered, and folded by blocks rather than by characters. The
                fold is still here for the reason it always was — a ClickUp
                description is regularly a specification, and a screen that
                opens on eight hundred words has buried the status and the
                buttons under them — but a cut between two things somebody
                wrote beats a cut at character nine hundred, and the expander
                can name what is under it. */}
            {body ? (
              <Card style={{ gap: SPACE.md }}>
                <Md text={body} host={host} pastPicture limit={wholeBody ? undefined : BODY_BLOCKS} />
                {bodyRest.hidden ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setWholeBody((was) => !was)}
                    style={{ minHeight: TAP, justifyContent: "center" }}
                  >
                    <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "600" }}>
                      {wholeBody
                        ? "Show less"
                        : bodyRest.nextHeading
                          ? `${bodyRest.nextHeading}${bodyRest.hidden > 1 ? ` and ${bodyRest.hidden - 1} more` : ""}`
                          : `${bodyRest.hidden} more`}
                    </Text>
                  </Pressable>
                ) : null}
              </Card>
            ) : null}

            {card.comments !== undefined && card.comments > 0 && !detail?.comments.length ? (
              <Note>{card.comments} {card.comments === 1 ? "comment" : "comments"} on the board.</Note>
            ) : null}

            {!mayWrite ? (
              <Card>
                <Note>
                  This phone may look but not change anything. That was chosen at the computer while
                  somebody was reading the request.
                </Note>
              </Card>
            ) : null}

            {/* Work that hangs off this card. Subtasks and checklist items are
                the same question asked two ways — what is left — so they are
                counted together in the heading and listed apart, because the
                board treats them differently and renaming somebody's workflow
                is not ours to do. */}
            {(detail?.subtasks.length || detail?.checklists.length) ? (
              <View style={{ gap: SPACE.sm }}>
                <Label text={`Underneath · ${leftOver} of ${allOver} left`} />
                <Card style={{ gap: SPACE.xs }}>
                  {detail.subtasks.map((sub) => (
                    <Pressable
                      key={sub.id}
                      accessibilityRole="button"
                      onPress={() => router.push({ pathname: "/card/[id]", params: { id: sub.id } })}
                      style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, minHeight: TAP }}
                    >
                      <Glyph
                        name={sub.statusKind === "done" ? "ok_circle" : "circle"}
                        color={statusInk(sub.statusColor) ?? C.text3}
                        size={18}
                      />
                      <Text
                        numberOfLines={1}
                        style={{
                          color: sub.statusKind === "done" ? C.text4 : C.text2,
                          fontSize: T.small, flex: 1,
                        }}
                      >{sub.title}</Text>
                      <ChevronIcon color={C.text4} size={17} />
                    </Pressable>
                  ))}
                  {detail.checklists.map((list) => (
                    <View key={list.name} style={{ gap: 2, paddingTop: SPACE.xs }}>
                      {list.name ? <Note>{list.name}</Note> : null}
                      {list.items.map((item, i) => (
                        <View
                          key={`${list.name}-${i}`}
                          /* No `minHeight`, and that is the point rather than an
                             omission: a checklist item is not a target. The
                             subtask rows above it navigate and take `TAP`; this
                             one is read-only, so its height is its text and
                             test/tap-floor.test.ts has nothing to weigh. */
                          style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingVertical: 3 }}
                        >
                          <Glyph name={item.done ? "ok_circle" : "circle"} color={item.done ? C.success : C.text3} size={16} />
                          <Text
                            style={{
                              color: item.done ? C.text4 : C.text2, fontSize: T.small, flex: 1,
                              textDecorationLine: item.done ? "line-through" : "none",
                            }}
                          >{item.name}</Text>
                        </View>
                      ))}
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}

            {/* The pull requests. `stated` is marked because the two ways one
                is found are not equally trustworthy: the card's own field NAMES
                one, and a search of GitHub for the card's id is a good guess at
                the rest. A reader deciding whether the work is done should know
                which they are looking at. */}
            {prs?.length ? (
              <View>
                <GroupTitle text={`Pull requests · ${prs.length}`} />
                <Group inset={50}>
                  {prs.map((pr) => (
                    <Row
                      key={pr.number}
                      title={`#${pr.number} ${pr.title || pr.url}`}
                      sub={prLine(pr)}
                      lead={<PrsIcon color={prInk(pr)} size={20} />}
                      chevron
                      // In the app when the computer has a checkout of it — see
                      // model/prRef.ts — and the browser only when it has not.
                      onPress={() => { if (host) void openLinkedPr(host, router, pr.url); }}
                    />
                  ))}
                </Group>
                {needsFoundNote(prs) ? (
                  <View style={{ paddingHorizontal: SPACE.xs, paddingTop: SPACE.xs }}>
                    <Note>
                      Found by searching GitHub for this card&apos;s id, so one of these may belong to
                      something else that mentions it.
                    </Note>
                  </View>
                ) : null}
              </View>
            ) : null}

            {/* What was said on the board. Read-only here on purpose: the box
                above posts a new one, and answering a specific comment is a
                thread, which ClickUp models and this screen does not. */}
            {detail?.comments.length ? (
              <View style={{ gap: SPACE.sm }}>
                <Label text={`Said on the board · ${detail.comments.length}`} />
                {/* The same rail and bubble as a pull request's conversation
                    (review/Bubble.tsx): a face, who and when, the words. */}
                <View style={{ paddingTop: SPACE.xs }}>
                  {detail.comments.map((c, i) => (
                    <Rail
                      key={c.id}
                      lead={<Avatar name={c.who} avatar={c.avatar} initials={c.initials} color={c.color} size={AVATAR.rail} />}
                      size={AVATAR.rail} first={i === 0} last={i === detail.comments.length - 1}
                    >
                      <Bubble
                        author={c.who} badge={c.mine ? "YOU" : null} when={since(c.at, now)} dim={c.resolved}
                        chips={c.resolved ? <Chip label="Resolved" tone="good" /> : undefined}
                      >
                        {c.text ? (
                          <Md text={c.text} host={host} />
                        ) : (
                          /* ClickUp comments can be an attachment and nothing
                             else, which arrives as empty text. Saying so beats a
                             blank row that reads as a rendering fault. */
                          <Note>An attachment, with nothing written.</Note>
                        )}
                      </Bubble>
                      {(c.replyList ?? []).map((r) => (
                        <View key={r.id} style={{ flexDirection: "row", gap: SPACE.sm, marginTop: SPACE.sm, alignItems: "flex-start" }}>
                          <Avatar name={r.who} avatar={r.avatar} initials={r.initials} color={r.color} size={AVATAR.field} />
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Bubble author={r.who} badge={r.mine ? "YOU" : null} when={since(r.at, now)}>
                              <Md text={r.text} host={host} />
                            </Bubble>
                          </View>
                        </View>
                      ))}
                      {c.replies && !(c.replyList ?? []).length ? (
                        <Note>{c.replies} {c.replies === 1 ? "reply" : "replies"}, on the board.</Note>
                      ) : null}
                    </Rail>
                  ))}
                </View>
              </View>
            ) : null}

            <View style={{ gap: SPACE.xs }}>
              <Text style={{ color: C.text3, fontSize: T.eyebrow, fontFamily: MONO }}>
                {card.customId || card.id}
              </Text>
              {card.url ? (
                <Btn label={`Open in ${providerTitle(PROVIDER)}`} onPress={() => { void Linking.openURL(card.url); }} />
              ) : null}
            </View>
          </>
        ) : null}
      </ScrollView>

      {card && mayWrite ? (
        <View onLayout={(e) => setBarH(e.nativeEvent.layout.height)} style={{
          paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.lg,
          borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
        }}>
          {mayComment.why ? <Note>{mayComment.why}</Note> : null}
          <View style={{ flexDirection: "row", gap: SPACE.sm }}>
            <Btn label="Comment" disabled={!mayComment.can} style={{ flex: 1 }} onPress={() => setCommenting(true)} />
            <Btn
              label="Start with Claude"
              tone="primary"
              style={{ flex: 1.6 }}
              onPress={() => { setFind(""); setPicking(true); }}
            />
          </View>
        </View>
      ) : null}

      {/* The status sheet closes as the write starts: the row shows the spinner,
          and a dialog may open over the screen a moment later (two modals at once
          is what the review screen's own comment warns about). */}
      {card ? (
        <StatusSheet
          open={choosing}
          onClose={() => setChoosing(false)}
          list={card.list}
          statuses={statuses}
          current={card.status}
          onMove={(status) => { setChoosing(false); void move(status); }}
        />
      ) : null}

      {/* Like the status sheet, it closes as the write starts. */}
      {card ? (
        <AssigneeSheet
          open={assigning}
          onClose={() => setAssigning(false)}
          id={card.customId || card.id}
          members={roster}
          error={rosterError}
          onRetry={() => { void readRoster(true); }}
          current={card.people}
          onApply={(diff) => { setAssigning(false); void apply(diff); }}
        />
      ) : null}

      <StatusConflict
        dialog={conflict?.dialog ?? assignConflict?.dialog ?? null}
        busy={busy !== null}
        onKeep={() => { setConflict(null); setAssignConflict(null); }}
        onOverwrite={() => {
          const c = conflict, a = assignConflict;
          setConflict(null);
          setAssignConflict(null);
          if (c) void move(c.wanted, { stamp: c.stamp });
          else if (a) void apply(a.diff, { stamp: a.stamp });
        }}
      />

      {moved ? (
        <Snackbar
          text={moved.undone ? "Moved back to " : "Moved to "}
          strong={moved.to}
          action={undo ? "Undo" : undefined}
          onAction={undo ? () => { void move(undo, { undo: true }); } : undefined}
          onDone={snackDone}
          bottom={card && mayWrite ? barH : 0}
        />
      ) : assigned ? (
        <Snackbar
          text={assigned.undone ? "Assignees restored" : "Assignees updated · "}
          strong={assigned.undone ? undefined : summaryText(assigned.diff, (n) => nameIn(peopleKnown, n))}
          action={undoPeople ? "Undo" : undefined}
          onAction={undoPeople ? () => { void apply(undoPeople, { undo: true }); } : undefined}
          onDone={snackDone}
          bottom={card && mayWrite ? barH : 0}
        />
      ) : null}

      {/* Saying something, in a sheet from the bar. It was a box open in the
          middle of the page between the facts and the statuses, where the
          keyboard pushed everything that mattered off the screen. Read-only
          history stays on the page ("Said on the board"); answering a
          specific comment is a thread, which ClickUp models and this does not. */}
      <Sheet open={commenting} onClose={() => setCommenting(false)} title="Comment on the card">
        <View style={{ gap: SPACE.md, paddingBottom: SPACE.md }}>
          <TextInput
            value={say}
            onChangeText={setSay}
            placeholder="A note on the card…"
            placeholderTextColor={C.text3}
            multiline
            autoFocus
            style={{
              minHeight: 96, borderWidth: 1, borderColor: C.border2,
              borderRadius: RADIUS.md, backgroundColor: C.bg,
              color: C.text, padding: SPACE.md, fontSize: T.body, textAlignVertical: "top",
            }}
          />
          <Btn
            label="Post it"
            tone="primary"
            busy={busy === "comment"}
            disabled={!say.trim() || busy !== null}
            onPress={() => { void comment().then(() => setCommenting(false)); }}
          />
        </View>
      </Sheet>

      {/* WHAT, before WHERE. The order is the point: the checkout is a detail of
          running it and the instruction is the decision. */}
      <Sheet open={picking} onClose={() => setPicking(false)} title="What should it do?">
        <SheetRow
          label="Just hand it the card"
          sub={card ? `${card.customId || card.id} — ${card.title}` : undefined}
          on={picked === null}
          onPress={() => { setPicked(null); setPicking(false); setHanding(true); }}
        />

        {skills === null ? (
          <View style={{ paddingTop: SPACE.md }}>
            <Note>Reading your skills from the computer…</Note>
          </View>
        ) : null}

        {skills?.length === 0 ? (
          <View style={{ paddingTop: SPACE.md }}>
            <Note>
              No skill on that computer mentions a card. The row above still works, and so does
              writing the instruction yourself once the window is open.
            </Note>
          </View>
        ) : null}

        {skills?.length ? (
          <>
            <View style={{ paddingTop: SPACE.md, paddingBottom: SPACE.sm }}>
              <TextInput
                value={find}
                onChangeText={setFind}
                placeholder={`Search ${skills.length} skills`}
                placeholderTextColor={C.text4}
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  minHeight: TAP, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.md,
                  backgroundColor: C.bg, color: C.text, paddingHorizontal: SPACE.md, fontSize: T.body,
                }}
              />
            </View>
            {shownSkills.map((skill) => (
              <SheetRow
                key={skill.name}
                label={`/${skill.name}`}
                /* The description, because a name is not enough to choose by —
                   and the group, because "named for a card" and "mentions one"
                   are different levels of confidence and the menu should not
                   pretend otherwise. */
                sub={[namedForIt(skill) ? "takes a card" : "mentions cards", skill.description]
                  .filter(Boolean).join(" · ")}
                on={picked?.skill.name === skill.name}
                onPress={() => {
                  const modes = skillModes(skill.argument_hint);
                  setPicked({ skill });
                  // A skill with gears asks which one; one without goes
                  // straight on to the checkout.
                  if (!modes.length) { setPicking(false); setHanding(true); }
                }}
              />
            ))}
            {shownSkills.length === 0 ? (
              <View style={{ paddingTop: SPACE.md }}><Note>Nothing matches that.</Note></View>
            ) : null}
          </>
        ) : null}

        {/* The gears a skill advertises, from its own invocation line. Shown
            only once one is picked, because they belong to it. */}
        {pickedModes.length ? (
          <View style={{ paddingTop: SPACE.lg, gap: SPACE.xs }}>
            <Label text={`How should /${picked!.skill.name} run?`} />
            {["", ...pickedModes].map((mode) => (
              <SheetRow
                key={mode || "default"}
                label={mode || "as it comes"}
                on={(picked!.mode ?? "") === mode}
                onPress={() => {
                  setPicked({ skill: picked!.skill, mode: mode || undefined });
                  setPicking(false);
                  setHanding(true);
                }}
              />
            ))}
          </View>
        ) : null}
      </Sheet>

      <Sheet open={handing} onClose={() => setHanding(false)} title="Which checkout?">
        {repos.map((repo) => (
          <SheetRow
            key={repo.root}
            label={repo.name}
            sub={repo.branch}
            onPress={() => hand(repo)}
          />
        ))}
        <View style={{ paddingTop: SPACE.md }}>
          <Note>
            {/* Said out loud because a wrong answer here is expensive and looks
                right: an agent opened in the wrong project is indistinguishable
                from one opened in the right one until it edits something. */}
            A card is not a checkout, so this has to be asked. The window opens in the one you
            pick, running{" "}
            <Text style={{ fontFamily: MONO, color: C.text2 }}>
              {card ? (picked
                ? `${skillCommand(picked.skill.name, card)}${picked.mode ? ` ${picked.mode}` : ""}`
                : `${card.customId || card.id} — ${card.title}`) : ""}
            </Text>.
          </Note>
        </View>
      </Sheet>
    </KeyboardAvoidingView>
  );
}
