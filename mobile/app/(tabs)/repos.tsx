/*
 * The working tree, from a sofa.
 *
 * Every checkout, not one per repository — and that is the opposite of the
 * rule the pull-request screen follows, deliberately. Linked worktrees of one
 * repository answer with the SAME pull requests, so asking six of them draws
 * one card six times; but each has its OWN uncommitted work, so collapsing
 * them would hide exactly the thing this screen exists to show.
 *
 * A switch per file IS the staging — there is no separate "add" step, because
 * on a phone a two-step commit is a step people forget half of. Then a title
 * and Commit, and Push if the branch is ahead.
 *
 * Writing needs the `full` scope. A phone paired to answer gates gets the list
 * and no buttons, which is the honest shape: the grant was chosen at the
 * computer by somebody looking at the request.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, Text, TextInput, View,
} from "react-native";
import * as Haptics from "expo-haptics";
import type { GitFileStatus, GitRepoRef, RepoStatus } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { Btn, Note } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

/** The glyph for what happened to a file. A letter as well as a colour: at
 *  11px outdoors, colour alone is not a signal to rely on, and for a good
 *  number of people it is not a signal at all. */
function mark(file: GitFileStatus): { glyph: string; ink: string } {
  switch (file.status) {
    case "added": case "untracked": return { glyph: "+", ink: C.success };
    case "deleted": return { glyph: "−", ink: C.error };
    case "unmerged": return { glyph: "!", ink: C.error };
    case "renamed": case "copied": return { glyph: "→", ink: C.info };
    default: return { glyph: "~", ink: C.warning };
  }
}

export default function ReposScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const [repos, setRepos] = useState<GitRepoRef[] | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [commitEnabled, setCommitEnabled] = useState(true);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [pulling, setPulling] = useState(false);

  const mayWrite = host?.scope === "full";

  useEffect(() => {
    if (!host) return;
    void (async () => {
      const answer = await ask<{ repos: GitRepoRef[] }>(host, "/git/repos");
      if (!answer.ok) { setSaid({ ok: false, text: answer.error }); return; }
      const found = Array.isArray(answer.value.repos) ? answer.value.repos : [];
      setRepos(found);
      setRoot((current) => current ?? found[0]?.root ?? null);
    })();
  }, [host]);

  const load = useCallback(async (): Promise<void> => {
    if (!host || !root) return;
    const answer = await ask<{ repos: RepoStatus[]; commitEnabled: boolean }>(host, "/git/status", {
      method: "POST",
      // A path, not a repository name: this route takes the directories to look
      // at, which is what makes it answer for a worktree rather than for the
      // repository the worktree belongs to.
      body: { paths: [root] },
    });
    if (!answer.ok) { setSaid({ ok: false, text: answer.error }); return; }
    setCommitEnabled(answer.value.commitEnabled !== false);
    setStatus(Array.isArray(answer.value.repos) ? answer.value.repos[0] ?? null : null);
  }, [host, root]);

  useEffect(() => { setStatus(null); setTitle(""); void load(); }, [load]);

  /** Every git write goes through here so there is one place that reports, one
   *  that re-reads, and one that cannot be pressed twice. */
  const act = useCallback(async (
    what: string, path: string, body: Record<string, unknown>,
  ): Promise<void> => {
    if (!host) return;
    setBusy(what);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const answer = await ask<{ ok: boolean; error?: string }>(host, path, { method: "POST", body });
    setBusy(null);
    if (!answer.ok) { setSaid({ ok: false, text: answer.error }); return; }
    if (!answer.value.ok) { setSaid({ ok: false, text: answer.value.error ?? "git refused that" }); return; }
    setSaid(null);
    await load();
  }, [host, load]);

  const files = useMemo(() => status?.files ?? [], [status]);
  const staged = useMemo(() => files.filter((f) => f.staged), [files]);

  const repo = repos?.find((r) => r.root === root) ?? null;

  if (!host) return null;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ borderBottomWidth: 1, borderBottomColor: C.border }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: SPACE.sm, paddingVertical: SPACE.sm, gap: SPACE.xs }}
        >
          {(repos ?? []).map((r) => {
            const on = r.root === root;
            return (
              <Pressable
                key={r.root}
                onPress={() => setRoot(r.root)}
                style={{
                  paddingHorizontal: SPACE.md, minHeight: 44, justifyContent: "center",
                  borderRadius: RADIUS.md,
                  backgroundColor: on ? C.bg3 : "transparent",
                  borderWidth: 1, borderColor: on ? C.border2 : "transparent",
                }}
              >
                <Text style={{ color: on ? C.text : C.text3, fontSize: T.small, fontWeight: on ? "600" : "400" }}>
                  {r.name}
                  {/* A dot, not a count: "there is uncommitted work here" is the
                      thing you scan a strip of twenty checkouts for. */}
                  {r.dirty ? <Text style={{ color: C.warning }}> ●</Text> : null}
                </Text>
                <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }} numberOfLines={1}>
                  {r.branch}{r.ahead ? ` ↑${r.ahead}` : ""}{r.behind ? ` ↓${r.behind}` : ""}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {said ? (
        <View style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.xs, backgroundColor: C.bg2 }}>
          <Text style={{ color: said.ok ? C.success : C.error, fontSize: T.eyebrow }}>{said.text}</Text>
        </View>
      ) : null}

      <FlatList
        data={files}
        keyExtractor={(f) => f.path}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl }}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => { setPulling(true); void load().finally(() => setPulling(false)); }}
            tintColor={C.text3}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: SPACE.xs, paddingBottom: SPACE.sm }}>
            <Text style={{ color: C.text, fontSize: T.title, fontWeight: "600" }}>
              {files.length === 0
                ? "Nothing changed here"
                : `${files.length} changed · ${staged.length} staged`}
            </Text>
            {repo ? (
              <Note>
                {repo.branch}
                {repo.ahead ? ` · ${repo.ahead} to push` : ""}
                {repo.behind ? ` · ${repo.behind} behind` : ""}
              </Note>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          status === null ? <ActivityIndicator color={C.text3} /> : null
        }
        renderItem={({ item }) => {
          const m = mark(item);
          return (
            <Pressable
              disabled={!mayWrite || !!busy}
              onPress={() => {
                // The switch IS the staging. One tap, one git call, one re-read.
                void act(
                  `stage:${item.path}`,
                  item.staged ? "/git/unstage" : "/git/stage",
                  { root, paths: [item.path] },
                );
              }}
              style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md, minHeight: 44 }}
            >
              <View style={{
                width: 20, height: 20, borderRadius: 5,
                borderWidth: 1, borderColor: item.staged ? C.success : C.border2,
                backgroundColor: item.staged ? C.success : "transparent",
                opacity: mayWrite ? 1 : 0.4,
                alignItems: "center", justifyContent: "center",
              }} />
              <Text style={{ color: m.ink, fontSize: T.small, fontFamily: MONO, width: 12 }}>{m.glyph}</Text>
              <Text
                style={{ color: C.text2, fontSize: T.small, fontFamily: MONO, flex: 1 }}
                numberOfLines={1}
                ellipsizeMode="head"
              >
                {item.path}
              </Text>
            </Pressable>
          );
        }}
      />

      {mayWrite && commitEnabled && files.length > 0 ? (
        <View style={{
          gap: SPACE.sm, padding: SPACE.lg,
          borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
        }}>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="What this commit does"
            placeholderTextColor={C.text4}
            style={{
              minHeight: 44, borderRadius: RADIUS.md, backgroundColor: C.bg,
              borderWidth: 1, borderColor: C.border, color: C.text,
              paddingHorizontal: SPACE.md, fontSize: T.body,
            }}
          />
          <View style={{ flexDirection: "row", gap: SPACE.sm }}>
            <Btn
              label={staged.length ? `Commit ${staged.length}` : "Nothing staged"}
              tone="primary"
              style={{ flex: 1 }}
              disabled={!staged.length || !title.trim()}
              busy={busy === "commit"}
              onPress={() => {
                /*
                 * The title is typed and never inferred. `RepoStatus.suggested`
                 * looks like a suggested message and is not — it is the list of
                 * dirty paths from the request — and a commit named by a field
                 * nobody read is worse on a phone than anywhere else, because
                 * nobody is going to notice before it is pushed.
                 */
                void act("commit", "/git/commit-staged", {
                  root, title: title.trim(), body: "",
                }).then(() => setTitle(""));
              }}
            />
            <Btn
              label={repo?.ahead ? `Push ${repo.ahead}` : "Push"}
              style={{ flex: 1 }}
              busy={busy === "push"}
              onPress={() => { void act("push", "/git/push", { root }); }}
            />
          </View>
        </View>
      ) : null}

      {!mayWrite ? (
        <View style={{ padding: SPACE.lg, borderTopWidth: 1, borderTopColor: C.border }}>
          <Note>
            This phone may look but not change anything. That was chosen at the computer while
            somebody was reading the request; to change it, forget this phone there and pair again.
          </Note>
        </View>
      ) : null}
    </View>
  );
}
