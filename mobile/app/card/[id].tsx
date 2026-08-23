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
import type { ProviderTask } from "../../../shared/providers.ts";
import type { GitRepoRef } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { requestHandoff } from "../../src/terminal/handoff.ts";
import { mainCheckouts } from "../../src/model/prRows.ts";
import { dueIn } from "../../src/lib/dates.ts";
import { Btn, Card, Label, Note, Sheet, SheetRow, TAP, Toggle } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

/** One status the card can be moved to, as the list defines it. */
interface Status { status: string; color?: string; type?: string }

/** The workspace's colour, with a floor: some boards pick a status colour that
 *  is legible on their own white background and vanishes on this one. The same
 *  rule, and the same reason, as the list's. */
function statusInk(color?: string): string {
  return color && color !== "#ffffff" ? color : C.text3;
}

/** A tmux window name that says which card it is and survives `tmux ls`.
 *  tmux treats a dot as a pane separator in target strings, so a window named
 *  with one cannot be selected by name later. */
function windowName(card: ProviderTask): string {
  const raw = (card.customId || card.id).toLowerCase();
  return raw.replace(/[^a-z0-9-]/g, "").slice(0, 24) || "card";
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
  const [handing, setHanding] = useState(false);
  const [say, setSay] = useState("");

  const load = useCallback(async (): Promise<void> => {
    if (!host || !id) return;
    const answer = await ask<{ ok?: boolean; task?: ProviderTask; error?: string }>(
      host, `/clickup/task?id=${encodeURIComponent(id)}`,
    );
    if (!answer.ok) { setError(answer.error); return; }
    if (!answer.value.task) {
      setError(answer.value.error || "That card could not be read.");
      return;
    }
    setError(null);
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

  /** Leave the window request and go to the terminal. The text is the card —
   *  its id and its title — which is what the desktop's own row hand-off
   *  sends, and the id is the HUMAN one because that is what every skill,
   *  branch name and commit message here is written against. */
  const hand = useCallback((repo: GitRepoRef): void => {
    if (!card) return;
    const label = card.customId || card.id;
    requestHandoff({
      t: "tmux",
      cmd: "issue",
      cwd: repo.root,
      name: windowName(card),
      prompt: `${label} — ${card.title}`,
      agent: true,
      title: card.title,
    });
    setHanding(false);
    router.push("/terminal");
  }, [card, router]);

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

            {/* No description: `ProviderTask` does not carry one. The board's
                own page has it and the button at the bottom goes there — what
                is shown here is everything the wire actually holds, rather
                than an empty box where a body would be. */}
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
          <Btn label="✦ Hand to Claude" tone="primary" onPress={() => setHanding(true)} />
        </View>
      ) : null}

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
            A card is not a checkout, so this has to be asked. The window opens in the one you pick,
            with the card&apos;s id and title as the prompt.
          </Note>
        </View>
      </Sheet>
    </KeyboardAvoidingView>
  );
}
