/*
 * One issue, read on a phone.
 *
 * Pushed onto the root stack rather than mounted as a tab, the way the
 * conversation used to be: it is entered from a list and left again, and
 * nothing else navigates to it.
 *
 * ── what this screen is for, and what it is not ───────────────────────────
 * It is for deciding. An issue is the one kind of work that arrives with no
 * branch behind it, so the question is always the same — is this mine, has
 * anybody started it, and is there already a pull request that closes it. All
 * three are answered above the fold and none of them are in the title.
 *
 * `/issues/prs` is a SECOND round trip on purpose: the server's own comment
 * says the description should not wait on GitHub answering twice. So the body
 * paints immediately and the linked pull requests fill in under it, which is
 * the same two-pass shape the pull request list already uses for its checks.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Linking, Pressable, ScrollView, Text, TextInput, View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import type { IssueDetail, IssuePr, IssuePrsReport, IssueStartResult } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { Md } from "../../src/md/Md.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { requestHandoff } from "../../src/terminal/handoff.ts";
import { openLinkedPr } from "../../src/state/open-pr.ts";
import { repoOf } from "../../src/model/prRef.ts";
import { since } from "../../src/lib/dates.ts";
import { canRunAgents } from "../../src/model/scope.ts";
import { Btn, Card, Chip, Group, GroupTitle, Label, LabelChip, Note, Row, Sheet, TAP } from "../../src/ui.tsx";
import { IssuesIcon, PrsIcon } from "../../src/nav/icons.tsx";
import { RADIUS as R } from "../../src/theme.ts";
import { C, MONO, SPACE, T } from "../../src/theme.ts";

/** What a linked pull request is called, and what colour that is. `linked` is
 *  the difference between one somebody attached and a bare `#123` that
 *  appeared in a body somewhere — see IssuePr. Showing the second as the first
 *  promises a fix nobody committed to. */
function prTone(pr: IssuePr): { word: string; ink: string } {
  if (pr.state === "MERGED") return { word: "merged", ink: C.success };
  if (pr.state === "CLOSED") return { word: "closed", ink: C.text3 };
  if (pr.draft) return { word: "draft", ink: C.text3 };
  return { word: pr.linked ? "will close this" : "mentions it", ink: pr.linked ? C.success : C.text3 };
}

export default function IssueScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host, fleet } = useAgentglass();
  const router = useRouter();
  const { number, root } = useLocalSearchParams<{ number: string; root: string }>();
  /* Cutting a branch is a write. A phone paired to answer gates does not get
     to do it, and the control is not drawn rather than drawn and refused. */
  const mayWrite = host?.scope === "full";

  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [prs, setPrs] = useState<IssuePr[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /** One box, two buttons. `/issues/claim` takes an optional comment and posts
   *  it in the same call as the assignment, so claiming with a note is one
   *  request rather than two — and two would be two ways to half-fail. */
  const [say, setSay] = useState("");
  const [busy, setBusy] = useState<"comment" | "claim" | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!host || !number || !root) return;
    const query = `root=${encodeURIComponent(root)}&number=${encodeURIComponent(number)}`;
    const answer = await ask<{ ok: boolean; issue?: IssueDetail; error?: string }>(
      host, `/issues/detail?${query}`,
    );
    if (!answer.ok) { setError(answer.error); return; }
    if (!answer.value.ok || !answer.value.issue) {
      setError(answer.value.error || "That issue could not be read.");
      return;
    }
    setError(null);
    setDetail(answer.value.issue);
  }, [host, number, root]);

  useEffect(() => { void load(); }, [load]);

  // The second pass. Fired beside the first rather than after it: they are
  // independent questions and the phone is on a phone network, where two
  // requests in flight beat two in sequence.
  useEffect(() => {
    if (!host || !number || !root) return;
    let gone = false;
    void (async () => {
      const query = `root=${encodeURIComponent(root)}&number=${encodeURIComponent(number)}`;
      const answer = await ask<IssuePrsReport>(host, `/issues/prs?${query}`);
      if (gone || !answer.ok) return;
      setPrs(Array.isArray(answer.value.prs) ? answer.value.prs : []);
    })();
    return () => { gone = true; };
  }, [host, number, root]);

  /**
   * Cut the worktree, then leave the window request for the terminal.
   *
   * The prompt is the SERVER's — `startIssue` writes it from the issue it just
   * read — so this sends back what it was handed rather than composing one. A
   * phone that wrote its own would be a second place the wording lives.
   */
  const start = useCallback(async (): Promise<void> => {
    // `mayWrite` again, under the button that already hides on it: the server
    // would refuse `/issues/start` and the terminal both, and a phone that
    // asked anyway would be shown a pane it cannot open. See model/scope.ts.
    if (!host || !detail || !root || !mayWrite) return;
    setStarting(true);
    setError(null);
    const answer = await ask<IssueStartResult>(host, "/issues/start", {
      method: "POST",
      // `worktree` and not `branch`: a branch switch is refused on a dirty
      // checkout, and the checkout in question is the one somebody is working
      // in right now. A worktree is its own directory and cannot disturb it.
      body: { root, number: detail.number, mode: "worktree" },
    });
    setStarting(false);
    if (!answer.ok) { setError(answer.error); return; }
    if (!answer.value.ok || !answer.value.cwd) {
      setError(answer.value.error || "That branch could not be cut.");
      return;
    }
    requestHandoff({
      t: "tmux",
      cmd: "issue",
      cwd: answer.value.cwd,
      // A tmux window name is an id, findable in `tmux ls`, and the title is
      // the sentence. They answer different questions and neither replaces the
      // other — the same split the desktop's own hand-off makes.
      name: `i${detail.number}`,
      prompt: answer.value.prompt ?? "",
      agent: true,
      title: detail.title,
    });
    void load();
    router.push("/terminal");
  }, [host, detail, root, router, load, mayWrite]);

  const now = Date.now();
  /**
   * Say something, or take it — and taking it can carry what was typed.
   *
   * Both land on the issue and neither is undoable from here, which is why the
   * result is reported rather than assumed: the server answers with its own
   * sentence ("Assigned and commented", "Assigned, but the comment failed")
   * and that half-failure is a real one worth reading. A screen that just
   * cleared the box would report a comment nobody posted.
   */
  const act = useCallback(async (what: "comment" | "claim"): Promise<void> => {
    if (!host || !detail || !root) return;
    const text = say.trim();
    if (what === "comment" && !text) return;
    setBusy(what);
    setSaid(null);
    const answer = await ask<{ ok: boolean; error?: string; detail?: string }>(
      host,
      what === "claim" ? "/issues/claim" : "/issues/comment",
      {
        method: "POST",
        body: what === "claim"
          ? { root, number: detail.number, comment: text || undefined }
          : { root, number: detail.number, body: text },
      },
    );
    setBusy(null);
    if (!answer.ok) { setSaid({ ok: false, text: answer.error }); return; }
    if (!answer.value.ok) {
      setSaid({ ok: false, text: answer.value.error || "GitHub refused that." });
      return;
    }
    setSay("");
    setSaid({ ok: true, text: answer.value.detail || "Done." });
    // Re-read, because both of these change what "Who has it" says.
    void load();
  }, [host, detail, root, say, load]);

  const closed = (detail?.state ?? "").toLowerCase() === "closed";
  const [commenting, setCommenting] = useState(false);
  const mine = !!detail && detail.assignees.length > 0 && !!fleet.me && detail.assignees.includes(fleet.me);

  return (
    /* `padding`, on both platforms, and never Platform-conditional — the rule
       and the measurement behind it are in test/keyboard-inset.test.ts. This
       screen takes typing, so it is in scope for it. */
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior="padding">
      <Stack.Screen options={{ title: `#${number}` }} />
      <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.xs, paddingBottom: SPACE.xl }}>

      {error ? (
        <Card>
          <Label text="Cannot read it" />
          <Note tone="bad">{error}</Note>
        </Card>
      ) : null}

      {!detail && !error ? <ActivityIndicator color={C.text3} /> : null}

      {detail ? (
        <>
          <View style={{ gap: 10, paddingHorizontal: SPACE.xs, paddingBottom: SPACE.md }}>
            <Text style={{ color: C.text, fontSize: T.head, fontWeight: "600", lineHeight: 26 }}>
              {detail.title}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Chip
                label={closed ? "Closed" : "Open"}
                tone={closed ? "neutral" : "good"}
                icon={<IssuesIcon color={closed ? C.text2 : C.success} size={14} />}
              />
              {detail.labels.map((l) => <LabelChip key={l.name} name={l.name} color={l.color} />)}
            </View>
            <Text style={{ color: C.text3, fontSize: T.small }}>
              Opened by {detail.author} · updated {since(detail.updatedAt, now)}
            </Text>
          </View>

          {/*
            Is this mine, has anybody started it: the facts a decision is made
            from, as one group of rows rather than a card of sentences.

            `work` is the server's record of a branch cut FROM this app for
            this issue. It is the difference between "nobody has started it"
            and "somebody has, somewhere else", and only the machine knows it.
          */}
          <Group>
            <Fact
              name="Assignee"
              value={detail.assignees.length ? (mine ? "You" : detail.assignees.join(", ")) : "Nobody yet"}
              quiet={!detail.assignees.length}
              trail={mayWrite && !closed && !detail.assignees.length ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy !== null}
                  onPress={() => { void act("claim"); }}
                  style={({ pressed }) => ({ minHeight: TAP, justifyContent: "center", paddingHorizontal: SPACE.sm, opacity: pressed ? 0.7 : 1 })}
                >
                  {busy === "claim"
                    ? <ActivityIndicator color={C.primary} />
                    : <Text style={{ color: C.primary, fontSize: T.body, fontWeight: "600" }}>Assign to me</Text>}
                </Pressable>
              ) : undefined}
            />
            <Fact
              name="Work"
              value={detail.work ? `${detail.work.branch} · ${since(new Date(detail.work.startedAt).toISOString(), now)}` : "Not started"}
              mono={!!detail.work}
              quiet={!detail.work}
            />
            {detail.milestone ? <Fact name="Milestone" value={detail.milestone} /> : null}
          </Group>
          {said ? <View style={{ paddingHorizontal: SPACE.xs, paddingTop: SPACE.xs }}><Note tone={said.ok ? "quiet" : "bad"}>{said.text}</Note></View> : null}

          <View style={{ paddingTop: SPACE.md }}>
            {detail.body.trim() ? (
              <Card>
                {/* Rendered, and never reflowed into something that reads like a
                    different report: a report's own headings, its numbered steps
                    and its fenced output are how it argues, and flattening them
                    is what made an issue harder to read here than on the web.
                    Uncapped, because an issue is read rather than skimmed — the
                    cap belongs on a pull request template, not on somebody's
                    account of a bug. */}
                <Md text={detail.body.trim()} host={host} />
              </Card>
            ) : (
              <Card>
                <Note>This issue has no description.</Note>
              </Card>
            )}
          </View>

          {/* The discussion, read here. The count used to be all there was and
              the way to the comments was GitHub. Oldest first, like the page. */}
          {detail.thread.length ? (
            <>
              <GroupTitle text={detail.comments > detail.thread.length
                ? `Comments · latest ${detail.thread.length} of ${detail.comments}`
                : `Comments · ${detail.thread.length}`} />
              <View style={{ gap: SPACE.xs }}>
                {detail.thread.map((c, i) => (
                  <Card key={`${c.createdAt}-${i}`}>
                    <Text style={{ color: C.text3, fontSize: T.small }}>
                      <Text style={{ color: C.text, fontWeight: "600" }}>{c.author}</Text>
                      {c.createdAt ? ` · ${since(c.createdAt, now)}` : ""}
                    </Text>
                    {c.body.trim() ? <Md text={c.body.trim()} host={host} /> : <Note>No text.</Note>}
                  </Card>
                ))}
              </View>
            </>
          ) : null}

          <GroupTitle text="Linked pull requests" />
          {prs === null ? (
            // "Not asked yet" is a different claim from "there are none", and
            // drawing the second during the first is how a screen lies.
            <View style={{ paddingHorizontal: SPACE.xs }}><Note>Asking GitHub…</Note></View>
          ) : prs.length === 0 ? (
            <View style={{ paddingHorizontal: SPACE.xs }}><Note>Nothing open against this issue yet.</Note></View>
          ) : (
            <Group inset={50}>
              {prs.map((pr) => {
                const tone = prTone(pr);
                return (
                  <Row
                    key={pr.number}
                    title={`#${pr.number} ${pr.title}`}
                    sub={tone.word}
                    lead={<PrsIcon color={tone.ink} size={20} />}
                    chevron
                    // In the app when the computer has the checkout — see
                    // model/prRef.ts — and the browser only when it has not.
                    onPress={() => {
                      if (host && pr.url) void openLinkedPr(host, router, pr.url, { repo: repoOf(detail.url), root: root ?? "" });
                    }}
                  />
                );
              })}
            </Group>
          )}

          {/* The way out to the full thing, for everything this screen does not
              carry — the reactions, the cross-references.
              At the BOTTOM and not the primary action: the point of this screen
              is that you did not have to go there. */}
          {detail.url ? (
            <View style={{ paddingTop: SPACE.lg }}>
              <Btn label="Open on GitHub" onPress={() => { void Linking.openURL(detail.url); }} />
            </View>
          ) : null}
        </>
      ) : null}
      </ScrollView>

      {/*
        The bar: say something, and the shortest path there is from reading a
        bug to working on it.

        `/issues/start` cuts the worktree and the branch and hands back a
        directory and a prompt; the letterbox then opens a tmux window with the
        agent in it. Two steps rather than one because they are two different
        failures — a branch that could not be cut is worth saying out loud, and
        a terminal that has not attached yet is not a reason to have not cut it.

        Only with `full`. Commenting, claiming and cutting a branch are writes
        to somebody else's repository, and a phone paired to answer gates does
        not get to make them — not drawn rather than drawn and refused. Comment
        is not offered on a closed issue: claiming one is not a real thing, and
        a box with one live button beside one dead one is worse than nothing.

        Already started, the primary is the way back to that work rather than a
        sentence telling you to go and find it: "Open it in the terminal." used
        to be a line of text with nothing to press. The terminal picks the
        window this issue's work is in — by its name, then by its directory.
      */}
      {detail && mayWrite ? (
        <View style={{
          flexDirection: "row", gap: SPACE.sm,
          paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.lg,
          borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
        }}>
          {!closed ? <Btn label="Comment" style={{ flex: 1 }} onPress={() => setCommenting(true)} /> : null}
          {detail.work ? (
            canRunAgents(host?.scope) ? (
              <Btn
                label="Open in terminal"
                tone="primary"
                style={{ flex: 1.6 }}
                onPress={() => router.push({
                  pathname: "/terminal",
                  params: { where: detail.work!.path, window: detail.work!.window ?? `i${detail.number}` },
                })}
              />
            ) : null
          ) : (
            <Btn
              label="Start with Claude"
              tone="primary"
              style={{ flex: 1.6 }}
              busy={starting}
              onPress={() => { void start(); }}
            />
          )}
        </View>
      ) : null}

      <Sheet open={commenting} onClose={() => setCommenting(false)} title={`Comment on #${number}`}>
        <View style={{ gap: SPACE.md, paddingBottom: SPACE.md }}>
          <TextInput
            value={say}
            onChangeText={setSay}
            placeholder="A note on the issue…"
            placeholderTextColor={C.text3}
            multiline
            autoFocus
            style={{
              minHeight: 96, borderWidth: 1, borderColor: C.border2,
              borderRadius: R.md, backgroundColor: C.bg,
              color: C.text, padding: SPACE.md, fontSize: T.body, textAlignVertical: "top",
            }}
          />
          <View style={{ flexDirection: "row", gap: SPACE.sm }}>
            <Btn
              label="Comment"
              style={{ flex: 1 }}
              busy={busy === "comment"}
              disabled={!say.trim() || busy !== null}
              onPress={() => { void act("comment").then(() => setCommenting(false)); }}
            />
            {!detail?.assignees.length ? (
              <Btn
                // The label says what the box will do, because the box changes
                // what the button means: claiming with something typed posts it
                // too, in the same call.
                label={say.trim() ? "Claim it, and say that" : "Claim it"}
                tone="primary"
                style={{ flex: 1.4 }}
                busy={busy === "claim"}
                disabled={busy !== null}
                onPress={() => { void act("claim").then(() => setCommenting(false)); }}
              />
            ) : null}
          </View>
          {said && !said.ok ? <Note tone="bad">{said.text}</Note> : null}
        </View>
      </Sheet>
    </KeyboardAvoidingView>
  );
}

/** A name and its value, the fact a decision is made from. */
function Fact({ name, value, trail, mono, quiet }: {
  name: string;
  value: string;
  trail?: React.ReactNode;
  mono?: boolean;
  quiet?: boolean;
}): React.ReactNode {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, minHeight: 48, paddingLeft: SPACE.lg, paddingRight: SPACE.sm }}>
      <Text style={{ color: C.text3, fontSize: 14, width: 96 }}>{name}</Text>
      <Text numberOfLines={1} style={{
        color: quiet ? C.text2 : C.text, fontSize: 14, fontWeight: "500", flex: 1, fontFamily: mono ? MONO : undefined,
      }}>{value}</Text>
      {trail}
    </View>
  );
}
