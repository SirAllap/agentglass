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
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import type { IssueDetail, IssuePr, IssuePrsReport, IssueStartResult } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { requestHandoff } from "../../src/terminal/handoff.ts";
import { since } from "../../src/lib/dates.ts";
import { Btn, Card, Label, Note } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

/** A label in the colour the repository gave it, with a floor — the same rule
 *  and the same reason as the list's. */
function labelInk(hex: string): string {
  const clean = (hex || "").replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(clean) ? `#${clean}` : C.text3;
}

/** What a linked pull request is called, and what colour that is. `linked` is
 *  the difference between one somebody attached and a bare `#123` that
 *  appeared in a body somewhere — see IssuePr. Showing the second as the first
 *  promises a fix nobody committed to. */
function prTone(pr: IssuePr): { word: string; ink: string } {
  if (pr.state === "MERGED") return { word: "merged", ink: C.success };
  if (pr.state === "CLOSED") return { word: "closed", ink: C.text4 };
  if (pr.draft) return { word: "draft", ink: C.text4 };
  return { word: pr.linked ? "will close this" : "mentions it", ink: pr.linked ? C.success : C.text3 };
}

export default function IssueScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const router = useRouter();
  const { number, root } = useLocalSearchParams<{ number: string; root: string }>();
  /* Cutting a branch is a write. A phone paired to answer gates does not get
     to do it, and the control is not drawn rather than drawn and refused. */
  const mayWrite = host?.scope === "full";

  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [prs, setPrs] = useState<IssuePr[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

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
    if (!host || !detail || !root) return;
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
  }, [host, detail, root, router, load]);

  const now = Date.now();
  const closed = (detail?.state ?? "").toLowerCase() === "closed";

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack.Screen options={{ title: `#${number}` }} />
      <ScrollView
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl }}
      >

      {error ? (
        <Card>
          <Label text="Cannot read it" />
          <Note tone="bad">{error}</Note>
        </Card>
      ) : null}

      {!detail && !error ? <ActivityIndicator color={C.text3} /> : null}

      {detail ? (
        <>
          <View style={{ gap: SPACE.sm }}>
            <Text style={{ color: C.text, fontSize: T.head, fontWeight: "700", lineHeight: 26 }}>
              {detail.title}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" }}>
              <View style={{
                paddingHorizontal: SPACE.sm, paddingVertical: 2, borderRadius: RADIUS.sm,
                borderWidth: 1, borderColor: closed ? C.text4 : C.success,
              }}>
                <Text style={{ color: closed ? C.text4 : C.success, fontSize: T.eyebrow }}>
                  {closed ? "closed" : "open"}
                </Text>
              </View>
              {detail.labels.map((l) => {
                const ink = labelInk(l.color);
                return (
                  <View key={l.name} style={{
                    paddingHorizontal: SPACE.sm, paddingVertical: 2, borderRadius: RADIUS.sm,
                    borderWidth: 1, borderColor: ink,
                  }}>
                    <Text style={{ color: ink, fontSize: T.eyebrow }}>{l.name}</Text>
                  </View>
                );
              })}
              <Text style={{ color: C.text4, fontSize: T.eyebrow }}>
                {detail.author} · {since(detail.updatedAt, now)}
              </Text>
            </View>
          </View>

          {detail.body.trim() ? (
            <Card>
              {/* Verbatim, and never reflowed into something that reads like a
                  different report. Markdown is not rendered here: an issue body
                  is somebody's description of a bug, and half-rendered markup
                  is harder to read than none. */}
              <Text style={{ color: C.text2, fontSize: T.body, lineHeight: 21 }}>
                {detail.body.trim()}
              </Text>
            </Card>
          ) : (
            <Card>
              <Note>This issue has no description.</Note>
            </Card>
          )}

          <Card style={{ gap: SPACE.sm }}>
            <Label text="Who has it" />
            <Note>
              {detail.assignees.length
                ? detail.assignees.join(", ")
                : "Nobody is assigned."}
            </Note>
            {/* `work` is the server's record of a branch cut FROM this app for
                this issue. It is the difference between "nobody has started
                it" and "somebody has, somewhere else", and only the machine
                knows it. */}
            {detail.work ? (
              <Note>
                Started here as <Text style={{ fontFamily: MONO, color: C.text2 }}>{detail.work.branch}</Text>
                {" "}· {since(new Date(detail.work.startedAt).toISOString(), now)}
              </Note>
            ) : null}
            {detail.milestone ? <Note>Milestone: {detail.milestone}</Note> : null}
          </Card>

          <View style={{ gap: SPACE.sm }}>
            <Label text="Pull requests" />
            {prs === null ? (
              // "Not asked yet" is a different claim from "there are none", and
              // drawing the second during the first is how a screen lies.
              <Note>Asking GitHub…</Note>
            ) : prs.length === 0 ? (
              <Card>
                <Note>Nothing open against this issue yet.</Note>
              </Card>
            ) : (
              prs.map((pr) => {
                const tone = prTone(pr);
                return (
                  <Pressable key={pr.number} onPress={() => { if (pr.url) void Linking.openURL(pr.url); }}>
                    <Card style={{ gap: SPACE.xs }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
                        <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>#{pr.number}</Text>
                        <Text style={{ color: tone.ink, fontSize: T.eyebrow }}>{tone.word}</Text>
                      </View>
                      <Text style={{ color: C.text, fontSize: T.body, lineHeight: 19 }}>{pr.title}</Text>
                    </Card>
                  </Pressable>
                );
              })
            )}
          </View>

          {/* The way out to the full thing, for everything this screen does not
              carry — the comment thread, the reactions, the cross-references.
              It is at the BOTTOM and it is not the primary action: the point of
              this screen is that you did not have to go there. */}
          {detail.url ? (
            <Btn label="Open on GitHub" onPress={() => { void Linking.openURL(detail.url); }} />
          ) : null}
        </>
      ) : null}
      </ScrollView>

      {/*
        The shortest path there is from reading a bug to working on it.

        `/issues/start` cuts the worktree and the branch and hands back a
        directory and a prompt; the letterbox then opens a tmux window with
        the agent in it. Two steps rather than one because they are two
        different failures — a branch that could not be cut is worth saying
        out loud, and a terminal that has not attached yet is not a reason to
        have not cut it.

        Only with `full`. It writes to the repository, and a phone paired to
        answer gates does not get to cut branches — the same rule repos.tsx
        follows, and the control is not drawn rather than drawn and refused.
      */}
      {detail && !detail.work && mayWrite ? (
        <View style={{
          paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.lg,
          borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
        }}>
          <Btn
            label="✦ Start with Claude"
            tone="primary"
            busy={starting}
            onPress={() => { void start(); }}
          />
        </View>
      ) : null}

      {detail?.work ? (
        <View style={{
          paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.lg,
          borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
        }}>
          <Note>
            Already started as <Text style={{ fontFamily: MONO, color: C.text2 }}>{detail.work.branch}</Text>.
            Open it in the terminal.
          </Note>
        </View>
      ) : null}
    </View>
  );
}
