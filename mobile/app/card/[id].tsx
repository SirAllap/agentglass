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
import type { CardPr, ProviderTask, TaskDetail } from "../../../shared/providers.ts";
import type { GitRepoRef, SkillInfo } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { requestHandoff } from "../../src/terminal/handoff.ts";
import { mainCheckouts } from "../../src/model/prRows.ts";
import { cardSkills, namedForIt, skillCommand, skillModes, windowName } from "../../../shared/cardSkills.ts";
import { dueIn, since } from "../../src/lib/dates.ts";
import { Btn, Card, Label, Note, Sheet, SheetRow, TAP, Toggle } from "../../src/ui.tsx";
import { ChevronIcon } from "../../src/nav/icons.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

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
const BODY_CAP = 900;

/** One status the card can be moved to, as the list defines it. */
interface Status { status: string; color?: string; type?: string }

/** The workspace's colour, with a floor: some boards pick a status colour that
 *  is legible on their own white background and vanishes on this one. The same
 *  rule, and the same reason, as the list's. */
function statusInk(color?: string): string {
  return color && color !== "#ffffff" ? color : C.text3;
}


export default function CardScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const mayWrite = host?.scope === "full";

  const [card, setCard] = useState<ProviderTask | null>(null);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Everything on the card that is not the card's own row. Null until the
   *  first read lands — an empty description and "not read yet" are different
   *  things and the screen draws them differently. */
  const [detail, setDetail] = useState<Omit<TaskDetail, "task"> | null>(null);
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
  const load = useCallback(async (): Promise<void> => {
    if (!host || !id) return;
    const answer = await ask<{ ok?: boolean; error?: string } & Partial<TaskDetail>>(
      host, `/clickup/task?id=${encodeURIComponent(id)}`,
    );
    if (!answer.ok) { setError(answer.error); return; }
    if (!answer.value.task) {
      setError(answer.value.error || "That card could not be read.");
      return;
    }
    setError(null);
    setDetail({
      description: answer.value.description ?? "",
      subtasks: answer.value.subtasks ?? [],
      checklists: answer.value.checklists ?? [],
      comments: answer.value.comments ?? [],
    });
    setCard(answer.value.task);
  }, [host, id]);

  useEffect(() => { void load(); }, [load]);

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
      const answer = await ask<{ ok?: boolean; statuses?: Status[] }>(
        host, `/clickup/list?id=${encodeURIComponent(card.listId!)}`,
      );
      if (!gone && answer.ok) setStatuses(answer.value.statuses ?? []);
    })();
    return () => { gone = true; };
  }, [host, card?.listId]);

  // Only when there is something to hand it to.
  useEffect(() => {
    if (!host || !mayWrite) return;
    let gone = false;
    void (async () => {
      const answer = await ask<{ repos: GitRepoRef[] }>(host, "/git/repos");
      if (!gone && answer.ok) {
        setRepos(mainCheckouts(Array.isArray(answer.value.repos) ? answer.value.repos : []));
      }
    })();
    return () => { gone = true; };
  }, [host, mayWrite]);

  const move = useCallback(async (status: string): Promise<void> => {
    if (!host || !card) return;
    setBusy(status);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const answer = await ask<{ ok: boolean; error?: string }>(host, "/clickup/status", {
      method: "POST",
      body: { id: card.id, status },
    });
    setBusy(null);
    if (!answer.ok) { setSaid({ ok: false, text: answer.error }); return; }
    if (!answer.value.ok) {
      setSaid({ ok: false, text: answer.value.error ?? "The board refused that." });
      return;
    }
    setSaid({ ok: true, text: `Moved to ${status}` });
    await load();
  }, [host, card, load]);

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
   * Take it, or put it down.
   *
   * `/clickup/assign` with no `user` is the self-assign toggle — the server
   * chooses between `assignSelf` and `setAssignee` on that field alone, and a
   * phone has no business naming somebody else: picking a colleague needs the
   * member list, a picker and a reason, and none of those belong on the screen
   * you open in a corridor.
   */
  const claim = useCallback(async (on: boolean): Promise<void> => {
    if (!host || !card) return;
    setBusy("assign");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const answer = await ask<{ ok: boolean; error?: string; conflict?: boolean }>(host, "/clickup/assign", {
      method: "POST",
      body: { id: card.id, on, updated: card.updated },
    });
    setBusy(null);
    if (!answer.ok) { setSaid({ ok: false, text: answer.error }); return; }
    if (!answer.value.ok) {
      setSaid({
        ok: false,
        // The board distinguishes these and so does this: "somebody else
        // changed it" is a reason to look, not a reason to try again.
        text: answer.value.conflict
          ? "The card moved on the board while this was open — reopen it and try again."
          : answer.value.error ?? "The board refused that.",
      });
      return;
    }
    setSaid({ ok: true, text: on ? "Assigned to you." : "Taken off you." });
    await load();
  }, [host, card, load]);

  /* After the card, and only once it has an id to search for. A failure is
     left as an empty list rather than an error on the screen: "no pull request
     mentions this card" and "GitHub could not be asked" look the same to a
     reader, so the section simply does not appear, and the card is still
     readable on a machine with no `gh`. */
  useEffect(() => {
    if (!host || !card) return;
    let gone = false;
    void (async () => {
      const query = `card=${encodeURIComponent(card.customId || card.id)}`;
      const answer = await ask<{ ok: boolean; prs?: CardPr[] }>(host, `/clickup/prs?${query}`);
      if (gone) return;
      setPrs(answer.ok ? answer.value.prs ?? [] : []);
    })();
    return () => { gone = true; };
  }, [host, card]);

  /* Asked once the card is on screen, not on opening the sheet: the list is a
     hundred-odd entries on a real machine and filtering it is instant, but
     fetching it while somebody watches a sheet appear is a sheet that appears
     empty. A failure leaves it null and the sheet says so — the plain hand-off
     does not depend on this and stays available either way. */
  useEffect(() => {
    if (!host || !card) return;
    let gone = false;
    void (async () => {
      const answer = await ask<{ skills?: SkillInfo[] }>(host, "/skills");
      if (gone) return;
      setSkills(answer.ok ? cardSkills(answer.value.skills ?? []) : null);
    })();
    return () => { gone = true; };
  }, [host, card]);

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
    if (!card) return;
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
  }, [card, picked, router]);

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
  // A card is never moved to the status it is already in — the picker offers
  // the others, which is also what stops a no-op write.
  const moves = statuses.filter((s) => s.status && s.status !== card?.status);

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
            <View style={{ gap: SPACE.sm }}>
              <Text style={{ color: C.text, fontSize: T.head, fontWeight: "700", lineHeight: 26 }}>
                {card.title}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" }}>
                <View style={{
                  paddingHorizontal: SPACE.sm, paddingVertical: 2, borderRadius: RADIUS.sm,
                  borderWidth: 1, borderColor: statusInk(card.statusColor),
                }}>
                  <Text style={{ color: statusInk(card.statusColor), fontSize: T.eyebrow }}>
                    {card.status}
                  </Text>
                </View>
                {card.list ? <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{card.list}</Text> : null}
                {card.sprint ? <Text style={{ color: C.text4, fontSize: T.eyebrow }}>· {card.sprint}</Text> : null}
                {when ? (
                  <Text style={{ color: when.late ? C.error : C.text4, fontSize: T.eyebrow }}>{when.text}</Text>
                ) : null}
              </View>
            </View>

            {said ? (
              <Note tone={said.ok ? "quiet" : "bad"}>{said.text}</Note>
            ) : null}

            {/* Verbatim, and capped. Markdown is not rendered here for the
                reason the pull request and issue screens both give: a
                description is prose somebody wrote, and half-rendered markup
                reads worse than none. The cap is because a ClickUp description
                is regularly a specification, and a screen that opens on eight
                hundred words has buried the status and the buttons under
                them. */}
            {body ? (
              <Card>
                <Text style={{ color: C.text2, fontSize: T.body, lineHeight: 21 }}>
                  {wholeBody ? body : body.slice(0, BODY_CAP)}
                  {!wholeBody && body.length > BODY_CAP ? "…" : ""}
                </Text>
                {body.length > BODY_CAP ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setWholeBody((was) => !was)}
                    style={{ minHeight: TAP, justifyContent: "center" }}
                  >
                    <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "600" }}>
                      {wholeBody ? "Show less" : `Show all ${body.length} characters`}
                    </Text>
                  </Pressable>
                ) : null}
              </Card>
            ) : null}

            <Card style={{ gap: SPACE.sm }}>
              <Label text="On the card" />
              {card.assignees.length ? (
                <Note>{card.assignees.join(", ")}</Note>
              ) : (
                <Note>Nobody is assigned.</Note>
              )}
              {card.priority ? <Note>Priority: {card.priority}</Note> : null}
              {card.tags.length ? <Note>{card.tags.join(" · ")}</Note> : null}
              {card.comments !== undefined && card.comments > 0 ? (
                <Note>{card.comments} {card.comments === 1 ? "comment" : "comments"} on the board.</Note>
              ) : null}
            </Card>

            {/*
              Taking it, and saying something.

              Only with `full`, not drawn otherwise — the rule repos.tsx set
              and the one every write in this app follows. Both of these are
              writes to somebody else's workspace.

              `mine` is the server's answer, not a search of `assignees` for a
              name the phone would have to know. Its own comment says why:
              "resolved server-side against the connected account, because the
              client has no business knowing your user id".
            */}
            {mayWrite ? (
              <Card style={{ gap: SPACE.sm }}>
                <Toggle
                  on={card.mine === true}
                  label={card.mine ? "It is yours" : "Take it"}
                  sub={
                    card.mine
                      ? "Turning this off takes you off the card."
                      : "Puts you on the card, alongside anybody already there."
                  }
                  disabled={busy !== null}
                  onPress={() => { void claim(card.mine !== true); }}
                />
                <TextInput
                  value={say}
                  onChangeText={setSay}
                  placeholder="A note on the card…"
                  placeholderTextColor={C.text4}
                  multiline
                  style={{
                    minHeight: 72, borderWidth: 1, borderColor: C.border,
                    borderRadius: RADIUS.sm, backgroundColor: C.bg,
                    color: C.text, padding: SPACE.sm, fontSize: T.body,
                  }}
                />
                <Btn
                  label="Post it"
                  busy={busy === "comment"}
                  disabled={!say.trim() || busy !== null}
                  onPress={() => { void comment(); }}
                />
              </Card>
            ) : null}

            {mayWrite && moves.length ? (
              <View style={{ gap: SPACE.sm }}>
                <Label text="Move to" />
                <View style={{ flexDirection: "row", gap: SPACE.sm, flexWrap: "wrap" }}>
                  {moves.map((s) => {
                    const ink = statusInk(s.color);
                    return (
                      <Pressable
                        key={s.status}
                        accessibilityRole="button"
                        disabled={!!busy}
                        onPress={() => { void move(s.status); }}
                        style={({ pressed }) => ({
                          minHeight: TAP, justifyContent: "center", paddingHorizontal: SPACE.md,
                          borderRadius: RADIUS.md, borderWidth: 1, borderColor: ink,
                          opacity: busy && busy !== s.status ? 0.4 : pressed ? 0.6 : 1,
                        })}
                      >
                        <Text style={{ color: ink, fontSize: T.small, fontWeight: "600" }}>
                          {busy === s.status ? "…" : s.status}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
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
                      <Text style={{ color: statusInk(sub.statusColor), fontSize: T.eyebrow }}>
                        {sub.statusKind === "done" ? "✓" : "○"}
                      </Text>
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
                          <Text style={{ color: item.done ? C.success : C.text4, fontSize: T.eyebrow }}>
                            {item.done ? "✓" : "○"}
                          </Text>
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
              <View style={{ gap: SPACE.sm }}>
                <Label text={`Pull requests · ${prs.length}`} />
                <Card style={{ gap: SPACE.xs }}>
                  {prs.map((pr) => (
                    <Pressable
                      key={pr.number}
                      accessibilityRole="button"
                      onPress={() => { void Linking.openURL(pr.url); }}
                      style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, minHeight: TAP }}
                    >
                      <Text style={{ color: prInk(pr), fontSize: T.eyebrow, fontFamily: MONO, width: 52 }}>
                        #{pr.number}
                      </Text>
                      <Text numberOfLines={1} style={{ color: C.text2, fontSize: T.small, flex: 1 }}>
                        {pr.title || pr.url}
                      </Text>
                      <Text style={{ color: prInk(pr), fontSize: T.eyebrow }}>
                        {pr.draft ? "draft" : pr.state.toLowerCase()}
                      </Text>
                    </Pressable>
                  ))}
                  {prs.some((pr) => !pr.stated) ? (
                    <Note>
                      Found by searching GitHub for this card&apos;s id, so one of these may belong to
                      something else that mentions it.
                    </Note>
                  ) : null}
                </Card>
              </View>
            ) : null}

            {/* What was said on the board. Read-only here on purpose: the box
                above posts a new one, and answering a specific comment is a
                thread, which ClickUp models and this screen does not. */}
            {detail?.comments.length ? (
              <View style={{ gap: SPACE.sm }}>
                <Label text={`Said on the board · ${detail.comments.length}`} />
                <Card style={{ gap: SPACE.md }}>
                  {detail.comments.map((c) => (
                    <View key={c.id} style={{ gap: 2 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
                        <Text style={{ color: C.text, fontSize: T.small, fontWeight: "600" }}>{c.who}</Text>
                        <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{since(c.at, now)}</Text>
                      </View>
                      {c.text ? (
                        <Text style={{ color: C.text2, fontSize: T.body, lineHeight: 20 }}>{c.text}</Text>
                      ) : (
                        /* ClickUp comments can be an attachment and nothing
                           else, which arrives as empty text. Saying so beats a
                           blank row that reads as a rendering fault. */
                        <Note>An attachment, with nothing written.</Note>
                      )}
                      {(c.replyList ?? []).map((r) => (
                        <View key={r.id} style={{
                          paddingLeft: SPACE.md, borderLeftWidth: 2, borderLeftColor: C.border,
                          marginTop: SPACE.xs, gap: 2,
                        }}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
                            <Text style={{ color: C.text2, fontSize: T.eyebrow, fontWeight: "600" }}>{r.who}</Text>
                            <Text style={{ color: C.text4, fontSize: T.eyebrow }}>{since(r.at, now)}</Text>
                          </View>
                          <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 18 }}>{r.text}</Text>
                        </View>
                      ))}
                      {c.replies && !(c.replyList ?? []).length ? (
                        <Note>{c.replies} {c.replies === 1 ? "reply" : "replies"}, on the board.</Note>
                      ) : null}
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}

            <View style={{ gap: SPACE.xs }}>
              <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>
                {card.customId || card.id}
              </Text>
              {card.url ? (
                <Btn label="Open in ClickUp" onPress={() => { void Linking.openURL(card.url); }} />
              ) : null}
            </View>
          </>
        ) : null}
      </ScrollView>

      {card && mayWrite ? (
        <View style={{
          paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.lg,
          borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
        }}>
          <Btn
            label="✦ Hand to Claude"
            tone="primary"
            onPress={() => { setFind(""); setPicking(true); }}
          />
        </View>
      ) : null}

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
