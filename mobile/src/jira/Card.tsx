/*
 * One Jira card, on the phone: what it is, where it stands, what it says, who
 * said what, the pull requests it names, and the move.
 *
 * ── three reads, in parallel, one per question ───────────────────────────
 * `/jira/detail` is the card's words (description, comments, activity, facts);
 * `/jira/transitions` is where it may go next; `/jira/prs` is a GitHub search
 * for the key, which is seconds rather than milliseconds and must not hold up a
 * card that can be read in one. The first two are what the screen is; the third
 * is a section that arrives when it does.
 *
 * ── the shape is the mock's ──────────────────────────────────────────────
 * Its own header (the key, the line that says which board and epic, the bell,
 * the way out to Jira), the state chips and the title, four things you came to
 * do as one row of tiles, then the card's blocks. The native header used to
 * draw the key and nothing else, which spent 56 points to repeat the first
 * word of the screen.
 *
 * ── the writes ───────────────────────────────────────────────────────────
 * A move, a comment, an assignee and a linked pull request. Every one is
 * `full` on the server; a phone paired to read or answer draws the controls
 * disabled with the sentence, rather than taking a gesture and returning 403.
 * The server also gates writes behind its own switch — this screen does not
 * guess at that, and the sheet shows the sentence the server sends.
 *
 * A move into a done status holds (`model/confirmPolicy.ts`); everything else
 * on this card is a tap, because every other action can be undone with another.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CardPr, JiraMoves, ProviderTask, TaskDetail } from "../../../shared/providers.ts";
import { ask } from "../lib/api.ts";
import { useAgentglass } from "../state/host-context.tsx";
import { usePaletteTick } from "../state/use-palette.ts";
import { openLinkedPr } from "../state/open-pr.ts";
import { openHttp } from "../lib/openHttp.ts";
import { since } from "../lib/dates.ts";
import { appendComment, commentFrom } from "../model/jiraCard.ts";
import { BackIcon } from "../nav/icons.tsx";
import { InboxBell } from "../nav/InboxBell.tsx";
import { Btn, Chip, GroupTitle, Note, TAP } from "../ui.tsx";
import { FieldRow } from "../cards/FieldRow.tsx";
import { Avatar } from "../Avatar.tsx";
import { Md } from "../md/Md.tsx";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import { C, MONO, RADIUS, SPACE, T, tint } from "../theme.ts";
import { AssigneeSheet } from "./Assignee.tsx";
import { CommentSheet } from "./CommentSheet.tsx";
import { MoveSheet } from "./MoveSheet.tsx";
import { LinkPrSheet } from "./LinkPr.tsx";
import type { JiraMoveOutcome } from "../model/jiraMove.ts";

type Phase = "reading" | "ready" | "failed";

function priorityInk(p: ProviderTask["priority"]): string {
  return p === "urgent" ? C.error : p === "high" ? C.warning : p === "low" ? C.text4 : C.text3;
}

/** The first letter of the site's own word for the kind, in the colour this
 *  app already gives that kind of work. */
function typeMark(type: string | undefined): { letter: string; ink: string } {
  const t = (type ?? "").trim();
  if (!t) return { letter: "·", ink: C.text3 };
  const lower = t.toLowerCase();
  const ink = lower === "bug" ? C.error : lower === "story" ? C.primary : lower === "epic" ? C.warning : C.text2;
  return { letter: t[0]!.toUpperCase(), ink };
}

/** One tappable thing you came to do: the mark, then its word. */
function QuickTile({ icon, label, onPress, disabled }: {
  icon: GlyphName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1, minWidth: 0, minHeight: 52, alignItems: "center", justifyContent: "center", gap: 3,
        paddingHorizontal: 2, paddingVertical: 4, borderRadius: RADIUS.md, borderWidth: 1,
        borderColor: C.border, backgroundColor: pressed ? C.bg3 : C.bg2,
        opacity: disabled ? 0.45 : 1,
      })}
    >
      <Glyph name={icon} color={C.text2} size={17} />
      <Text numberOfLines={1} style={{ color: C.text2, fontSize: T.eyebrow, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/** A tile for one pull request. The whole row opens the pull request's own
 *  screen, which is where CI and the review live; the Jira read names the pull
 *  request and its GitHub state, not its checks. */
function PrTile({ pr, onOpen }: { pr: CardPr; onOpen: () => void }): React.ReactNode {
  const closed = pr.state.toUpperCase() === "CLOSED";
  const merged = pr.state.toUpperCase() === "MERGED";
  const ink = merged ? C.primary : closed ? C.error : pr.draft ? C.text3 : C.success;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open pull request ${pr.number}: ${pr.title || "no title"}`}
      onPress={onOpen}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center", gap: 10, minHeight: TAP, paddingHorizontal: SPACE.md,
        paddingVertical: 11, backgroundColor: pressed ? C.bg3 : "transparent",
        borderTopWidth: 1, borderTopColor: C.border,
      })}
    >
      <View style={{
        width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center",
        backgroundColor: tint(ink, 0.14),
      }}>
        <Glyph name="pr" color={ink} size={16} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: C.text, fontSize: 13, fontWeight: "600" }}>
          #{pr.number}{pr.title ? ` · ${pr.title}` : ""}
        </Text>
        <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
          {pr.state.toLowerCase()}{pr.draft ? " · draft" : ""}{pr.stated ? " · named on the card" : ""}
        </Text>
      </View>
      <Glyph name="down" color={C.text4} size={16} />
    </Pressable>
  );
}

export function JiraCard({ cardKey }: { cardKey: string }): React.ReactNode {
  usePaletteTick();
  const { host } = useAgentglass();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const full = host?.scope === "full";

  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [more, setMore] = useState(0);
  const [moves, setMoves] = useState<JiraMoves | null>(null);
  const [prs, setPrs] = useState<CardPr[] | null>(null);
  const [phase, setPhase] = useState<Phase>("reading");
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  const [moving, setMoving] = useState(false);
  const [linking, setLinking] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const composer = useRef<TextInput>(null);
  /* One timer for the line under the card: a second `say` replaces the first
     message rather than being cut short by the first one's clock. */
  const saidTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (saidTimer.current) clearTimeout(saidTimer.current); }, []);

  const card = detail?.task ?? null;
  const updated = card?.updated ?? 0;

  const loadDetail = useCallback(async (): Promise<void> => {
    if (!host) return;
    const answer = await ask<{ ok: boolean; error?: string; detail?: TaskDetail; more?: number }>(
      host, `/jira/detail?key=${encodeURIComponent(cardKey)}`,
    );
    if (!answer.ok) { setPhase("failed"); setError(answer.error); return; }
    if (!answer.value.ok || !answer.value.detail) { setPhase("failed"); setError(answer.value.error ?? "That card could not be read."); return; }
    setDetail(answer.value.detail);
    setMore(answer.value.more ?? 0);
    setPhase("ready");
    setError(null);
  }, [host, cardKey]);

  const loadMoves = useCallback(async (): Promise<void> => {
    if (!host) return;
    const answer = await ask<{ ok: boolean; options?: JiraMoves["options"]; cannot?: string; error?: string }>(
      host, `/jira/transitions?key=${encodeURIComponent(cardKey)}`,
    );
    if (answer.ok && answer.value.ok) setMoves({ options: answer.value.options ?? [], ...(answer.value.cannot ? { cannot: answer.value.cannot } : null) });
    else setMoves({ options: [], cannot: answer.ok ? answer.value.error ?? answer.value.cannot : answer.error });
  }, [host, cardKey]);

  const loadPrs = useCallback(async (): Promise<void> => {
    if (!host) return;
    const answer = await ask<{ ok: boolean; prs?: CardPr[] }>(host, `/jira/prs?key=${encodeURIComponent(cardKey)}`);
    if (answer.ok && answer.value.ok) setPrs(Array.isArray(answer.value.prs) ? answer.value.prs : []);
    else setPrs([]);
  }, [host, cardKey]);

  useEffect(() => {
    setDetail(null); setMoves(null); setPrs(null); setPhase("reading"); setError(null);
    void loadDetail();
    void loadMoves();
    void loadPrs();
  }, [loadDetail, loadMoves, loadPrs]);

  const say = (ok: boolean, text: string): void => {
    if (saidTimer.current) clearTimeout(saidTimer.current);
    setSaid({ ok, text });
    saidTimer.current = setTimeout(() => setSaid(null), 4000);
  };

  const postComment = async (): Promise<void> => {
    if (!host || !detail || !comment.trim() || posting) return;
    setPosting(true);
    const text = comment.trim();
    const answer = await ask<{ ok: boolean; error?: string; detail?: TaskDetail; more?: number; partial?: string }>(
      host, "/jira/comment", { method: "POST", body: { key: cardKey, text } },
    );
    setPosting(false);
    if (!answer.ok) { say(false, answer.error); return; }
    if (!answer.value.ok) { say(false, answer.value.error ?? "Jira did not take that comment."); return; }
    if (answer.value.detail) { setDetail(answer.value.detail); setMore(answer.value.more ?? more); }
    else {
      const now = Date.now();
      setDetail(appendComment(detail, commentFrom(`local-${now}`, "you", text, now)));
    }
    setComment("");
    say(true, answer.value.partial ?? "Comment posted");
  };

  const moved = (outcome: JiraMoveOutcome): void => {
    if (outcome.kind === "conflict") { say(false, "Somebody changed this card while you were moving it. Reload it."); return; }
    if (outcome.kind === "failed") { say(false, outcome.text); return; }
    if (outcome.task && detail) setDetail({ ...detail, task: outcome.task });
    say(true, `Moved to ${outcome.task?.status ?? "its new status"}`);
    void loadDetail(); // the site's own activity, not our guess at it
    void loadMoves();
  };

  const openPr = (pr: CardPr): void => { if (host) void openLinkedPr(host, router, pr.url); };

  const header = (
    <View style={{ paddingTop: insets.top, backgroundColor: C.bg }}>
      <View style={{ height: 52, flexDirection: "row", alignItems: "center", gap: SPACE.xs, paddingHorizontal: SPACE.xs }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to the board"
          onPress={() => router.back()}
          style={({ pressed }) => ({
            width: TAP, height: TAP, alignItems: "center", justifyContent: "center",
            borderRadius: RADIUS.md, backgroundColor: pressed ? C.bg3 : "transparent",
          })}
        >
          <BackIcon color={C.text} size={22} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ color: C.text, fontSize: T.title, fontWeight: "700" }}>{cardKey}</Text>
          {card?.list || card?.parent?.title ? (
            <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
              {[card?.list, card?.parent?.title].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
        </View>
        <InboxBell />
        {card?.url ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="Open in Jira"
            onPress={() => { openHttp(card.url); }}
            style={({ pressed }) => ({
              width: TAP, height: TAP, alignItems: "center", justifyContent: "center",
              borderRadius: RADIUS.md, backgroundColor: pressed ? C.bg3 : "transparent",
            })}
          >
            <Glyph name="external" color={C.text2} size={20} />
          </Pressable>
        ) : null}
      </View>
      <View style={{ height: 1, backgroundColor: C.border }} />
    </View>
  );

  if (phase === "reading") {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {header}
        <View style={{ padding: SPACE.md }}>
          <Note>Reading its fields, its words and its pull requests together…</Note>
        </View>
      </View>
    );
  }
  if (phase === "failed" || !detail || !card) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        {header}
        <View style={{ padding: SPACE.md, gap: SPACE.md }}>
          <Text accessibilityRole="header" style={{ color: C.text, fontSize: 15, fontWeight: "600" }}>Cannot open this card</Text>
          <Note tone="bad">{error ?? "Jira did not answer."}</Note>
          <Btn label="Read it again" onPress={() => { void loadDetail(); }} />
        </View>
      </View>
    );
  }

  const targets = moves?.options ?? [];
  const primary = targets[0];
  const facts = detail.facts ?? [];
  const firstPr = prs?.[0];
  const comments = detail.comments ?? [];
  const events = detail.events ?? [];
  const mark = typeMark(card.issueType);
  const who = card.people?.[0];
  const now = Date.now();

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {header}
      <ScrollView contentContainerStyle={{ paddingBottom: 104 }}>
        {/* What it is: the state, the kind, how loud, and which board. */}
        <View style={{ paddingHorizontal: SPACE.md, paddingTop: SPACE.md, gap: SPACE.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Chip
              label={card.status || "—"}
              tone={card.statusKind === "done" ? "good" : card.statusKind === "open" ? "neutral" : "warn"}
            />
            {card.issueType ? (
              <Chip
                label={card.issueType}
                icon={<Text style={{ color: mark.ink, fontSize: 10, fontWeight: "700" }}>{mark.letter}</Text>}
              />
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: priorityInk(card.priority) }} />
              <Text style={{ color: priorityInk(card.priority), fontSize: T.small, fontWeight: "600" }}>
                {card.priority ? card.priority[0]!.toUpperCase() + card.priority.slice(1) : "—"}
              </Text>
            </View>
            <View style={{ flex: 1 }} />
            {card.list ? (
              <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small, maxWidth: 140 }}>{card.list}</Text>
            ) : null}
          </View>
          <Text accessibilityRole="header" style={{ color: C.text, fontSize: 18, fontWeight: "700", lineHeight: 24 }}>
            {card.title}
          </Text>
        </View>

        {/* The four things you came to do. */}
        <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: SPACE.md, paddingTop: 10 }}>
          <QuickTile
            icon="people"
            label="Assignee"
            disabled={!full}
            onPress={() => setAssigning(true)}
          />
          <QuickTile
            icon="comment"
            label="Comment"
            disabled={!full}
            onPress={() => composer.current?.focus()}
          />
          {firstPr ? <QuickTile icon="pr" label={`#${firstPr.number}`} onPress={() => openPr(firstPr)} /> : null}
          <QuickTile icon="link" label="Link a PR" disabled={!full} onPress={() => setLinking(true)} />
        </View>

        {!full ? (
          <View style={{ paddingHorizontal: SPACE.md, paddingTop: SPACE.sm }}>
            <Note>This phone can read Jira but not change it. Pair again with full access to move, comment or assign.</Note>
          </View>
        ) : moves && !targets.length ? (
          <View style={{ paddingHorizontal: SPACE.md, paddingTop: SPACE.sm }}>
            <Note>{moves.cannot ?? "Jira lists no move from where this card stands. A workflow can answer that for a card you may not move."}</Note>
          </View>
        ) : null}

        {/* Fields, in the order a card is read: who has it, what it is, and the
            facts the site returned. */}
        <View style={{ paddingHorizontal: SPACE.md }}><GroupTitle text="Fields" /></View>
        <View style={{
          marginHorizontal: SPACE.md, backgroundColor: C.bg2, borderWidth: 1, borderColor: C.border,
          borderRadius: RADIUS.lg, overflow: "hidden",
        }}>
          <FieldRow
            label="Assignee"
            trail={full ? "chevron" : null}
            onPress={full ? () => setAssigning(true) : undefined}
            accessibilityLabel={`Assignee: ${who?.name ?? "unassigned"}`}
          >
            <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 7 }}>
              {who ? <Avatar name={who.name} initials={who.initials} size={22} /> : null}
              <Text numberOfLines={1} style={{ color: who ? C.text : C.text3, fontSize: 14, fontWeight: "600", flexShrink: 1 }}>
                {who?.name ?? "Unassigned"}
              </Text>
            </View>
          </FieldRow>
          {card.issueType ? (
            <FieldRow label="Type" trail={null}>
              <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
                <View style={{
                  width: 18, height: 18, borderRadius: 5, alignItems: "center", justifyContent: "center",
                  backgroundColor: tint(mark.ink, 0.16),
                }}>
                  <Text style={{ color: mark.ink, fontSize: 10, fontWeight: "700" }}>{mark.letter}</Text>
                </View>
                <Text style={{ color: C.text, fontSize: 14, fontWeight: "600" }}>{card.issueType}</Text>
              </View>
            </FieldRow>
          ) : null}
          <FieldRow label="Priority" trail={null}>
            <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: priorityInk(card.priority) }} />
              <Text style={{ color: priorityInk(card.priority), fontSize: 14, fontWeight: "600" }}>
                {card.priority ? card.priority[0]!.toUpperCase() + card.priority.slice(1) : "—"}
              </Text>
            </View>
          </FieldRow>
          {card.parent?.title ? (
            <FieldRow label={card.parent.type ?? "Epic"} trail={null}>
              <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
                <Text numberOfLines={1} style={{ color: C.text, fontSize: 14, fontWeight: "600", flexShrink: 1 }}>{card.parent.title}</Text>
              </View>
            </FieldRow>
          ) : null}
          {facts.map((f) => (
            <FieldRow key={f.id} label={f.label} trail={null}>
              <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 7 }}>
                {f.initials ? <Avatar name={f.value} initials={f.initials} avatar={f.avatar} size={22} /> : null}
                <Text numberOfLines={1} style={{ color: C.text, fontSize: 14, fontWeight: "600", flexShrink: 1 }}>
                  {f.value || "—"}
                </Text>
              </View>
            </FieldRow>
          ))}
          {card.tags.length ? (
            <FieldRow label="Labels" trail={null}>
              <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 5 }}>
                {card.tags.map((tag) => <Chip key={tag} label={tag} />)}
              </View>
            </FieldRow>
          ) : null}
        </View>

        {/* Pull requests */}
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: SPACE.md }}>
          <View style={{ flex: 1 }}><GroupTitle text="Pull requests" /></View>
          {full ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Link a pull request to ${cardKey}`}
              onPress={() => setLinking(true)}
              style={{ minHeight: TAP, justifyContent: "center", paddingHorizontal: SPACE.sm }}
            >
              <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "600" }}>Link</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={{
          marginHorizontal: SPACE.md, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border,
          backgroundColor: C.bg2, overflow: "hidden",
        }}>
          {prs === null ? (
            <View style={{ padding: SPACE.md }}><Note>Looking for pull requests that name {cardKey}…</Note></View>
          ) : prs.length ? (
            prs.map((pr) => <PrTile key={pr.number} pr={pr} onOpen={() => openPr(pr)} />)
          ) : (
            <View style={{ padding: SPACE.md }}><Note>No pull request names {cardKey} yet.</Note></View>
          )}
        </View>

        {/* Description */}
        {detail.description?.trim() ? (
          <>
            <View style={{ paddingHorizontal: SPACE.md }}><GroupTitle text="Description" /></View>
            <View style={{
              marginHorizontal: SPACE.md, paddingVertical: 11, paddingHorizontal: 13, borderRadius: RADIUS.lg,
              backgroundColor: C.bg2, borderWidth: 1, borderColor: C.border,
            }}>
              <Md text={detail.description} host={host} />
            </View>
          </>
        ) : null}

        {/* Comments, with the composer where the reply belongs. */}
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: SPACE.md }}>
          <View style={{ flex: 1 }}>
            <GroupTitle text={`Comments${comments.length ? ` · ${comments.length}` : ""}`} />
          </View>
          {more > 0 ? <Text style={{ color: C.text4, fontSize: T.small, marginRight: SPACE.sm }}>{more} more</Text> : null}
          {full ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Add a comment to ${cardKey}`}
              onPress={() => setCommenting(true)}
              style={{ minHeight: TAP, justifyContent: "center", paddingHorizontal: SPACE.sm }}
            >
              <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "600" }}>Add</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={{
          marginHorizontal: SPACE.md, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border,
          backgroundColor: C.bg2, overflow: "hidden",
        }}>
          {comments.length ? comments.map((c, i) => (
            <View key={c.id} style={{
              flexDirection: "row", gap: 9, paddingVertical: 10, paddingHorizontal: 12,
              borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border,
            }}>
              <Avatar name={c.who} initials={c.initials} avatar={c.avatar} color={c.color} size={24} />
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                  <Text style={{ color: C.text, fontSize: 13, fontWeight: "600" }}>{c.who}</Text>
                  <Text style={{ color: C.text3, fontSize: T.small }}>{since(c.at, now)}</Text>
                </View>
                <Text style={{ color: C.text2, fontSize: 13, lineHeight: 19 }}>{c.text}</Text>
              </View>
            </View>
          )) : (
            <View style={{ padding: SPACE.md }}><Note>No comments yet.</Note></View>
          )}
          <View style={{
            flexDirection: "row", alignItems: "flex-end", gap: SPACE.sm, paddingVertical: 10, paddingHorizontal: 12,
            borderTopWidth: 1, borderTopColor: C.border,
          }}>
            <TextInput
              ref={composer}
              value={comment}
              onChangeText={setComment}
              placeholder={`Add a comment to ${cardKey}…`}
              placeholderTextColor={C.text4}
              accessibilityLabel={`Write a comment on ${cardKey}`}
              multiline
              editable={full}
              style={{
                flex: 1, minHeight: TAP - 4, maxHeight: 110, color: C.text, fontSize: 13.5, lineHeight: 19,
                textAlignVertical: "top", borderWidth: 1, borderColor: C.border2, borderRadius: RADIUS.md,
                paddingVertical: 11, paddingHorizontal: 12, backgroundColor: C.bg,
              }}
            />
            <Btn label="Send" tone="primary" busy={posting} disabled={!full || !comment.trim()} onPress={() => { void postComment(); }} />
          </View>
        </View>

        {/* Activity */}
        {events.length ? (
          <>
            <View style={{ paddingHorizontal: SPACE.md }}><GroupTitle text="Activity" /></View>
            <View style={{
              marginHorizontal: SPACE.md, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.border,
              backgroundColor: C.bg2, overflow: "hidden",
            }}>
              {events.map((e, i) => (
                <View key={`${e.at}-${i}`} style={{
                  flexDirection: "row", alignItems: "flex-start", gap: 9, paddingVertical: 9, paddingHorizontal: 13,
                  borderTopWidth: i === 0 ? 0 : 1, borderTopColor: C.border,
                }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: e.color ?? C.border2, marginTop: 5 }} />
                  <Text style={{ color: C.text2, fontSize: 12.5, lineHeight: 17.5, flex: 1 }}>
                    {e.who ? <Text style={{ fontWeight: "600" }}>{e.who} </Text> : null}
                    {e.text ?? (e.from ? `moved it from ${e.from} to ${e.status}` : e.status ? `moved it to ${e.status}` : e.kind)}
                  </Text>
                  <Text style={{ color: C.text3, fontSize: T.small }}>{since(e.at, now)}</Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        <View style={{ height: SPACE.md }} />
      </ScrollView>

      {/* The foot: the three writes, named the way the mock names them. */}
      <View style={{
        position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", gap: SPACE.sm,
        paddingHorizontal: SPACE.md, paddingVertical: 10, backgroundColor: C.bg2,
        borderTopWidth: 1, borderTopColor: C.border,
      }}>
        <View style={{ flex: 1 }}><Btn label="Assign" disabled={!full} onPress={() => setAssigning(true)} /></View>
        <View style={{ flex: 1 }}><Btn label="Link a PR" disabled={!full} onPress={() => setLinking(true)} /></View>
        <View style={{ flex: 1.15 }}>
          <Btn
            label={primary ? `Move to ${primary.toStatus}` : "No moves"}
            tone="primary"
            disabled={!full || !primary || !updated}
            onPress={() => setMoving(true)}
          />
        </View>
      </View>

      {said ? (
        <View
          accessibilityLiveRegion="polite"
          style={{
            position: "absolute", left: SPACE.md, right: SPACE.md, bottom: 84, minHeight: TAP, justifyContent: "center",
            paddingHorizontal: SPACE.lg, borderRadius: RADIUS.sm, backgroundColor: said.ok ? C.text : C.error,
          }}
        >
          <Text style={{ color: said.ok ? C.bg : C.text, fontSize: T.body }}>{said.text}</Text>
        </View>
      ) : null}

      {host ? (
        <>
      <MoveSheet
        open={moving}
        onClose={() => setMoving(false)}
        host={host}
        card={card}
        moves={targets}
        initial={primary ?? null}
        onMoved={moved}
      />

      <LinkPrSheet
        open={linking}
        onClose={() => setLinking(false)}
        host={host}
        cardKey={cardKey}
        linked={prs ?? []}
        onLinked={() => { void loadPrs(); say(true, "Pull request linked"); }}
      />

      <AssigneeSheet
        open={assigning}
        onClose={() => setAssigning(false)}
        host={host}
        card={card}
        onAssigned={(task) => { if (detail) setDetail({ ...detail, task }); }}
        onSaid={say}
      />

      <CommentSheet
        open={commenting}
        onClose={() => setCommenting(false)}
        host={host}
        cardKey={cardKey}
        onPosted={(next, moreComments) => { setDetail(next); setMore(moreComments); say(true, "Comment posted"); }}
      />
        </>
      ) : null}
    </View>
  );
}
