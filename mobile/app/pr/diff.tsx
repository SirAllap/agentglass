/*
 * The diff, one file at a time, with somewhere to say something about a line.
 *
 * ── unified, never side-by-side ──────────────────────────────────────────
 * 393 points cannot hold two columns of code. Split view is the desktop's and
 * belongs there; here the two sides interleave and the line numbers carry the
 * distinction, which is the arrangement every terminal diff has used since
 * before there were columns to split.
 *
 * ── the comments queue, and that is the point ────────────────────────────
 * Nothing is posted as it is written. Comments accumulate on the device and go
 * with the verdict in ONE call to `/prs/review-with`, so a phone that loses
 * signal halfway cannot leave half a review on somebody's pull request — three
 * remarks with no conclusion, which reads as an opinion nobody finished.
 *
 * It is also the shape GitHub actually wants: a review IS a verdict plus its
 * comments, and posting them one at a time makes a thread per remark.
 *
 * ── the whole diff arrives as one string ─────────────────────────────────
 * `/prs/diff` answers with the output of `gh pr diff`. Parsing it is
 * src/model/diffLines.ts, which is where the line-number arithmetic and its
 * tests live — a comment anchored to the wrong line is a remark about code the
 * author did not write.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import {
  commentableLine, fileLabel, parseDiff, type DiffFile, type DiffLine,
} from "../../src/model/diffLines.ts";
import { draftCount, takeDraft, type LineNote } from "../../src/model/reviewDraft.ts";
import { Btn, Card, Label, Note, Sheet, SheetRow, TAP } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

/** The two backgrounds a changed line takes.
 *
 *  Tinted rather than coloured: the TEXT stays the palette's own ink, because
 *  a diff read outdoors at 11px needs contrast more than it needs green. The
 *  marker column carries the sign as well, so the distinction survives for
 *  anybody who cannot rely on the tint. */
function lineFace(kind: DiffLine["kind"]): { bg: string; mark: string; ink: string } {
  if (kind === "add") return { bg: "rgba(63,185,80,0.14)", mark: "+", ink: C.success };
  if (kind === "del") return { bg: "rgba(248,81,73,0.14)", mark: "−", ink: C.error };
  return { bg: "transparent", mark: " ", ink: C.text4 };
}

export default function DiffScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const router = useRouter();
  const { number, root, path } = useLocalSearchParams<{
    number: string; root: string; path?: string;
  }>();

  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [picking, setPicking] = useState(false);
  /** The line a comment is being written against, and what has been typed. */
  const [writing, setWriting] = useState<{ line: number; body: string } | null>(null);
  /** Only to repaint the counter — the draft itself lives in the module, so it
   *  survives this screen being left and come back to. */
  const [queued, setQueued] = useState(0);

  const key = `${root}#${number}`;

  useEffect(() => { setQueued(draftCount(key)); }, [key]);

  useEffect(() => {
    if (!host || !number || !root) return;
    let gone = false;
    void (async () => {
      const query = `root=${encodeURIComponent(root)}&number=${encodeURIComponent(number)}`;
      const answer = await ask<{ ok: boolean; text?: string; error?: string }>(
        host, `/prs/diff?${query}`,
      );
      if (gone) return;
      if (!answer.ok) { setError(answer.error); return; }
      if (!answer.value.ok) { setError(answer.value.error || "That diff could not be read."); return; }
      setError(null);
      setText(answer.value.text ?? "");
    })();
    return () => { gone = true; };
  }, [host, number, root]);

  const files = useMemo(() => parseDiff(text ?? ""), [text]);

  // Land on the file that was tapped, when one was. Only once — moving after
  // that is the person's business.
  useEffect(() => {
    if (!path || !files.length) return;
    const found = files.findIndex((f) => f.path === path);
    if (found >= 0) setAt(found);
  }, [path, files]);

  const file: DiffFile | undefined = files[at];

  const add = useCallback((): void => {
    if (!writing || !writing.body.trim()) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const note: LineNote = {
      path: file?.path ?? "",
      line: writing.line,
      body: writing.body.trim(),
    };
    setQueued(takeDraft(key, (was) => [...was.filter((n) => !(n.path === note.path && n.line === note.line)), note]).length);
    setWriting(null);
  }, [writing, file, key]);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior="padding">
      <Stack.Screen options={{ title: file ? fileLabel(file).split("/").pop() ?? "Diff" : "Diff" }} />

      {/* Which file, and how far through. A picker rather than a strip: a pull
          request with eleven files is a list, and a list belongs in a sheet —
          the same argument the repository picker makes. */}
      <View style={{
        flexDirection: "row", alignItems: "center", gap: SPACE.sm,
        paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm,
        borderBottomWidth: 1, borderBottomColor: C.border,
      }}>
        <Pressable
          onPress={() => setPicking(true)}
          accessibilityRole="button"
          style={{ flex: 1, minHeight: TAP, justifyContent: "center" }}
        >
          <Text numberOfLines={1} style={{ color: C.text, fontSize: T.small, fontFamily: MONO }}>
            {file ? fileLabel(file) : "…"} ▾
          </Text>
        </Pressable>
        <Text style={{ color: C.text4, fontSize: T.eyebrow, fontFamily: MONO }}>
          {files.length ? `${at + 1}/${files.length}` : ""}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: SPACE.xl }}>
        {error ? (
          <View style={{ padding: SPACE.lg }}>
            <Card>
              <Label text="Cannot read it" />
              <Note tone="bad">{error}</Note>
            </Card>
          </View>
        ) : null}

        {text === null && !error ? (
          <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
        ) : null}

        {file?.binary ? (
          <View style={{ padding: SPACE.lg }}>
            <Card><Note>This file is binary — there is nothing to show.</Note></Card>
          </View>
        ) : null}

        {file?.hunks.map((hunk, h) => (
          <View key={`${hunk.header}-${h}`}>
            {/* The header verbatim, including gh's trailing context — usually
                the enclosing function, which is the most useful thing on
                screen for saying where you are. */}
            <View style={{
              backgroundColor: C.bg3, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs,
              borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.border,
            }}>
              <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.eyebrow, fontFamily: MONO }}>
                {hunk.header}
              </Text>
            </View>

            {hunk.lines.map((line, i) => {
              const face = lineFace(line.kind);
              const can = commentableLine(line);
              const open = writing?.line === can && can !== null;
              return (
                <View key={i}>
                  <Pressable
                    disabled={can === null}
                    onPress={() => setWriting(can === null ? null : { line: can, body: "" })}
                    style={{ flexDirection: "row", backgroundColor: face.bg, minHeight: 22 }}
                  >
                    {/* The new-side number, which is the one a comment anchors
                        to. The old side is deliberately not drawn: two columns
                        of digits on a 393-point screen is a third of the width
                        spent on something you look at once. */}
                    <Text style={{
                      width: 38, textAlign: "right", paddingRight: SPACE.sm,
                      color: C.text4, fontSize: 10.5, fontFamily: MONO, lineHeight: 20,
                    }}>{line.newNo ?? line.oldNo ?? ""}</Text>
                    <Text style={{
                      width: 10, color: face.ink, fontSize: 10.5, fontFamily: MONO, lineHeight: 20,
                    }}>{face.mark}</Text>
                    <Text
                      style={{
                        flex: 1, color: line.kind === "meta" ? C.text4 : C.text2,
                        fontSize: 10.5, fontFamily: MONO, lineHeight: 20, paddingRight: SPACE.sm,
                      }}
                    >{line.text || " "}</Text>
                  </Pressable>

                  {open ? (
                    <View style={{
                      margin: SPACE.md, borderWidth: 1, borderColor: C.primary,
                      borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.sm,
                    }}>
                      <Label text={`Comment on line ${writing!.line}`} />
                      <TextInput
                        value={writing!.body}
                        onChangeText={(body) => setWriting({ line: writing!.line, body })}
                        placeholder="What is wrong with it?"
                        placeholderTextColor={C.text4}
                        multiline
                        autoFocus
                        style={{
                          minHeight: 64, borderWidth: 1, borderColor: C.border,
                          borderRadius: RADIUS.sm, backgroundColor: C.bg,
                          color: C.text, padding: SPACE.sm, fontSize: T.body,
                        }}
                      />
                      <View style={{ flexDirection: "row", gap: SPACE.sm }}>
                        <Btn
                          label="Add to review"
                          tone="primary"
                          style={{ flex: 1 }}
                          disabled={!writing!.body.trim()}
                          onPress={add}
                        />
                        <Btn label="Cancel" onPress={() => setWriting(null)} />
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        ))}

        {file && !file.binary && file.hunks.length === 0 ? (
          <View style={{ padding: SPACE.lg }}>
            <Card>
              <Note>
                No lines changed in this file — it was {file.status}
                {file.from ? ` from ${file.from}` : ""}.
              </Note>
            </Card>
          </View>
        ) : null}
      </ScrollView>

      <View style={{
        flexDirection: "row", gap: SPACE.sm,
        paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.lg,
        borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
      }}>
        <Btn
          label="‹ Previous"
          style={{ flex: 1 }}
          disabled={at === 0}
          onPress={() => { setWriting(null); setAt((n) => Math.max(0, n - 1)); }}
        />
        {queued > 0 ? (
          <Btn
            label={`Review · ${queued}`}
            tone="primary"
            style={{ flex: 1 }}
            onPress={() => router.push({
              pathname: "/pr/[number]",
              params: { number: String(number), root: String(root), review: "1" },
            })}
          />
        ) : null}
        <Btn
          label="Next ›"
          style={{ flex: 1 }}
          disabled={at >= files.length - 1}
          onPress={() => { setWriting(null); setAt((n) => Math.min(files.length - 1, n + 1)); }}
        />
      </View>

      <Sheet open={picking} onClose={() => setPicking(false)} title="Files">
        {files.map((f, i) => (
          <SheetRow
            key={`${f.path}-${i}`}
            label={fileLabel(f)}
            sub={f.binary ? "binary" : `+${f.additions} −${f.deletions}`}
            on={i === at}
            onPress={() => { setAt(i); setWriting(null); setPicking(false); }}
          />
        ))}
      </Sheet>
    </KeyboardAvoidingView>
  );
}
