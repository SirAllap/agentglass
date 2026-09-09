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
 * ── the lines the hunk cut off ───────────────────────────────────────────
 * A hunk shows three lines of context and the question you have is usually
 * about the twentieth. At a desk that is answered by the editor next to the
 * browser; here there was no editor, so the answer was "open GitHub". The
 * expanders between hunks fetch the real file from `/prs/file-slice`, one
 * screen at a time. Those lines are context and cannot be commented on —
 * GitHub only accepts a comment on a line the diff touches, and drawing them
 * as pressable would be offering something that fails on send.
 *
 * ── what has already been said, on the line it was said about ────────────
 * A conversation lives on a line, and until this it lived on another screen:
 * you read the code here, and the remark about it two taps away, with nothing
 * on the diff to say there was one. So the threads are drawn where they
 * belong — one line each, opened by a tap into the same card the threads
 * screen draws, answered and resolved from here.
 *
 * Your own queued remarks are drawn the same way, in the review's colour
 * rather than a thread's: they are not a conversation yet and nobody else can
 * see them. Before this they vanished into a counter, which is how a remark
 * gets written twice.
 *
 * A thread whose lines have changed underneath it has no line to sit on —
 * GitHub clears it — and goes above the file rather than onto whatever now
 * carries that number.
 *
 * ── the whole diff arrives as one string ─────────────────────────────────
 * `/prs/diff` answers with the output of `gh pr diff`. Parsing it is
 * src/model/diffLines.ts, which is where the line-number arithmetic and its
 * tests live — a comment anchored to the wrong line is a remark about code the
 * author did not write.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import type { PrDetail } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import {
  commentableLine, fileLabel, parseDiff, type DiffFile, type DiffLine,
} from "../../src/model/diffLines.ts";
import { gapLabel, gapsIn, nextSlice, type Gap } from "../../src/model/expand.ts";
import { draft, takeDraft, type LineNote } from "../../src/model/reviewDraft.ts";
import { threadsOnFile } from "../../src/model/threads.ts";
import { ApplyConfirm } from "../../src/review/ApplyConfirm.tsx";
import { ThreadCard } from "../../src/review/ThreadCard.tsx";
import { ThreadMarker } from "../../src/review/ThreadMarker.tsx";
import { useThreadActions } from "../../src/review/useThreadActions.ts";
import { Btn, Card, Label, Note, Sheet, SheetRow, TAP } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T, tint } from "../../src/theme.ts";

/** The two backgrounds a changed line takes.
 *
 *  Tinted rather than coloured: the TEXT stays the palette's own ink, because
 *  a diff read outdoors at 11px needs contrast more than it needs green. The
 *  marker column carries the sign as well, so the distinction survives for
 *  anybody who cannot rely on the tint. */
function lineFace(kind: DiffLine["kind"]): { bg: string; mark: string; ink: string } {
  if (kind === "add") return { bg: tint(C.success, 0.14), mark: "+", ink: C.success };
  if (kind === "del") return { bg: tint(C.error, 0.14), mark: "−", ink: C.error };
  return { bg: "transparent", mark: " ", ink: C.text4 };
}

/** The lines fetched into a gap, drawn as context — no marker, no tint, and
 *  deliberately not pressable: GitHub takes a comment only on a line the diff
 *  touches, so a row that invited one here would fail on send. */
function Context({ from, lines }: { from: number; lines: string[] }): React.ReactNode {
  return (
    <>
      {lines.map((line, i) => (
        <View key={from + i} style={{ flexDirection: "row", minHeight: 22 }}>
          <Text style={{
            width: 38, textAlign: "right", paddingRight: SPACE.sm,
            color: C.text4, fontSize: 10.5, fontFamily: MONO, lineHeight: 20,
          }}>{from + i}</Text>
          <Text style={{ width: 10, fontSize: 10.5, fontFamily: MONO, lineHeight: 20 }}> </Text>
          <Text style={{
            flex: 1, color: C.text3, fontSize: 10.5, fontFamily: MONO,
            lineHeight: 20, paddingRight: SPACE.sm,
          }}>{line || " "}</Text>
        </View>
      ))}
    </>
  );
}

/** The bar that offers more, in the diff's own grey. Reads as part of the
 *  file rather than as a control laid over it, which is what it is. */
function Expander({ label, busy, onPress }: {
  label: string; busy: boolean; onPress: () => void;
}): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={busy}
      style={{
        backgroundColor: C.bg3, minHeight: TAP, justifyContent: "center",
        paddingHorizontal: SPACE.md, borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.border,
      }}
    >
      <Text style={{ color: busy ? C.text4 : C.primary, fontSize: T.eyebrow, fontFamily: MONO }}>
        {busy ? "…" : `⤢  ${label}`}
      </Text>
    </Pressable>
  );
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
  /** A copy of the draft, only so this screen repaints — the draft itself
   *  lives in the module, so it survives leaving here and coming back.
   *
   *  The whole list rather than its count, because a remark you have written
   *  and cannot see is a remark you write twice. They are drawn on their own
   *  lines below. */
  const [queued, setQueued] = useState<LineNote[]>([]);

  const key = `${root}#${number}`;

  useEffect(() => { setQueued(draft(key)); }, [key]);

  /** Which read is the current one. Two can be in flight — the first on
   *  arrival, a second after a suggestion is committed — and the answer that
   *  arrives last is not necessarily the one that was asked for last. */
  const diffRead = useRef(0);

  const loadDiff = useCallback(async (): Promise<void> => {
    if (!host || !number || !root) return;
    const mine = ++diffRead.current;
    const query = `root=${encodeURIComponent(root)}&number=${encodeURIComponent(number)}`;
    const answer = await ask<{ ok: boolean; text?: string; error?: string }>(
      host, `/prs/diff?${query}`,
    );
    if (mine !== diffRead.current) return;
    if (!answer.ok) { setError(answer.error); return; }
    if (!answer.value.ok) { setError(answer.value.error || "That diff could not be read."); return; }
    setError(null);
    setText(answer.value.text ?? "");
  }, [host, number, root]);

  useEffect(() => { void loadDiff(); }, [loadDiff]);

  /*
   * The conversations, from the same detail the threads screen reads.
   *
   * A second request on this screen and not a shared one, because the two
   * answers have different lifetimes: `/prs/diff` is the change and does not
   * move while you read it, and a thread does — somebody replies, somebody
   * resolves — and every write below re-reads exactly this. The server serves
   * both stale-while-revalidate, so the cost of asking here is one cached
   * answer, not one round trip to GitHub.
   */
  const [detail, setDetail] = useState<PrDetail | null>(null);

  const loadThreads = useCallback(async (): Promise<void> => {
    if (!host || !number || !root) return;
    const query = `root=${encodeURIComponent(root)}&number=${encodeURIComponent(number)}`;
    const answer = await ask<{ ok: boolean; detail?: PrDetail; error?: string }>(host, `/prs/detail?${query}`);
    // Deliberately quiet. The diff is the reason to be here; a pull request
    // whose detail cannot be read still shows its change, with no markers.
    if (answer.ok && answer.value.ok && answer.value.detail) setDetail(answer.value.detail);
  }, [host, number, root]);

  useEffect(() => { void loadThreads(); }, [loadThreads]);

  /*
   * After a write, both halves of the screen are re-read.
   *
   * The threads for the obvious reason — a reply has to appear, a resolve has
   * to take. The DIFF because one of these three writes a commit: applying a
   * suggestion changes the very lines under the card, and leaving them on
   * screen as they were is showing code that no longer exists, directly above
   * the conversation that just replaced it.
   */
  const reload = useCallback(async (): Promise<void> => {
    await Promise.all([loadThreads(), loadDiff()]);
  }, [loadThreads, loadDiff]);

  const actions = useThreadActions({
    host, root: root ?? "", number: number ?? "", reload,
  });

  /** Which thread is open. One at a time: two cards expanded in a diff is a
   *  screen with no code left on it. */
  const [reading, setReading] = useState<string | null>(null);

  const files = useMemo(() => parseDiff(text ?? ""), [text]);

  // Land on the file that was tapped, when one was. Only once — moving after
  // that is the person's business.
  useEffect(() => {
    if (!path || !files.length) return;
    const found = files.findIndex((f) => f.path === path);
    if (found >= 0) setAt(found);
  }, [path, files]);

  const file: DiffFile | undefined = files[at];

  /** This file's conversations: the ones with a line to sit on, and the ones
   *  whose lines have gone. */
  const onFile = useMemo(
    () => threadsOnFile(detail?.threads ?? [], file?.path ?? ""),
    [detail, file],
  );

  /** How many are still open, per file — the number the picker needs so you
   *  can find the file somebody is waiting on without opening all eleven. */
  const openByPath = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of detail?.threads ?? []) {
      if (t.isResolved) continue;
      counts.set(t.path, (counts.get(t.path) ?? 0) + 1);
    }
    return counts;
  }, [detail]);

  /** One expanded card belongs to the file it was opened on. Moving to
   *  another file leaves it behind rather than carrying it across. */
  useEffect(() => { setReading(null); }, [at]);

  /** What you have already written on this line, waiting to go with the
   *  verdict. In the review's own colour rather than a thread's: it is not a
   *  conversation yet, and nobody else can see it. */
  const yoursOn = (line: number | null): React.ReactNode => {
    if (line === null || !file) return null;
    const mine = queued.filter((n) => n.path === file.path && n.line === line);
    if (!mine.length) return null;
    return mine.map((note, i) => (
      <View
        key={`${note.line}-${i}`}
        style={{
          marginLeft: 38, paddingLeft: SPACE.sm, paddingRight: SPACE.md, paddingVertical: SPACE.sm,
          gap: SPACE.xs, backgroundColor: C.bg3,
          borderLeftWidth: 3, borderLeftColor: C.warning,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
          <Text style={{ color: C.warning, fontSize: T.eyebrow, fontWeight: "700", flex: 1 }}>
            Yours · not sent yet
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove your comment on line ${note.line}`}
            onPress={() => drop(note)}
            style={{ minHeight: TAP, justifyContent: "center", paddingLeft: SPACE.md }}
          >
            <Text style={{ color: C.text3, fontSize: T.eyebrow }}>Remove</Text>
          </Pressable>
        </View>
        <Text style={{ color: C.text2, fontSize: T.small, lineHeight: 18 }}>{note.body}</Text>
      </View>
    ));
  };

  /** The markers under one line of code, and the card when one is open. */
  const threadsOn = (line: number | null): React.ReactNode => {
    if (line === null) return null;
    const here = onFile.byLine.get(line);
    if (!here?.length) return null;
    return here.map((thread) => (
      <View key={thread.id}>
        <ThreadMarker
          thread={thread}
          open={reading === thread.id}
          onPress={() => setReading((was) => (was === thread.id ? null : thread.id))}
        />
        {reading === thread.id ? (
          <View style={{ padding: SPACE.md }}>
            {/* No path header and no hunk: the file is in the bar above and
                the code is the row this card is hanging from. Printing either
                again pushes the words themselves off the screen. */}
            <ThreadCard thread={thread} host={host} actions={actions} where={false} hunk={false} />
          </View>
        ) : null}
      </View>
    ));
  };

  /*
   * The context fetched around this file's hunks, one entry per gap.
   *
   * Keyed by file path and gap, so moving between files does not carry one
   * file's expansion onto another's line numbers — the fastest way to show
   * somebody the wrong code. Each gap grows in ONE direction and stays a single
   * contiguous run: the gap above the first hunk grows UPWARD from its bottom,
   * and every other gap grows DOWNWARD from its top. Both start at the edge
   * nearest the code that was being read, which is what the question is
   * usually about.
   */
  const [shown, setShown] = useState<Record<string, { from: number; to: number; lines: string[] }>>({});
  const [fetching, setFetching] = useState<string | null>(null);
  const [slipped, setSlipped] = useState<{ key: string; text: string } | null>(null);

  const gaps = useMemo(() => (file ? gapsIn(file) : []), [file]);

  /** Which way a gap grows. Stated once, because the renderer and the fetcher
   *  must agree — a gap drawn as growing up and fetched downward would append
   *  lines to the wrong end of what is on screen. */
  const dirOf = (gap: Gap): "up" | "down" => (gap.before === 0 ? "up" : "down");

  const expand = useCallback(async (gap: Gap): Promise<void> => {
    if (!host || !file || !number || !root) return;
    const key = `${file.path}#${gap.before}`;
    const have = shown[key];
    const dir = dirOf(gap);
    const edge = have ? (dir === "up" ? have.from : have.to) : null;
    const want = nextSlice(gap, dir, edge);
    if (!want) return;

    setFetching(key);
    setSlipped(null);
    const query = new URLSearchParams({
      root: String(root), number: String(number), path: file.path,
      // RIGHT: the file as this pull request leaves it, which is the side the
      // line numbers on screen belong to.
      side: "RIGHT", from: String(want.from), to: String(want.to),
    }).toString();
    const answer = await ask<{ ok: boolean; lines?: string[]; start?: number; binary?: boolean; error?: string }>(
      host, `/prs/file-slice?${query}`,
    );
    setFetching(null);
    if (!answer.ok) { setSlipped({ key, text: answer.error }); return; }
    if (!answer.value.ok) { setSlipped({ key, text: answer.value.error || "Those lines could not be read." }); return; }
    if (answer.value.binary) { setSlipped({ key, text: "That file is binary." }); return; }
    const got = answer.value.lines ?? [];
    /* The server clamps to the end of the file, so the tail gap can answer with
       fewer lines than were asked for — or none, which is how "that was the
       end" arrives. Trusting `want.to` here would draw blank numbered rows past
       the end of the file. */
    if (!got.length) { setSlipped({ key, text: "That is the end of the file." }); return; }
    /* And where it started is the SERVER's answer, not the number we asked
       with. It clamps that too, and the two differing by one puts real lines
       under wrong numbers — which on this screen is not a cosmetic fault: the
       numbers beside expanded context are what a reader uses to say where
       something is. */
    const first = Number.isInteger(answer.value.start) ? (answer.value.start as number) : want.from;
    setShown((was) => {
      const before = was[key];
      if (!before) return { ...was, [key]: { from: first, to: first + got.length - 1, lines: got } };
      return dir === "up"
        ? { ...was, [key]: { from: first, to: before.to, lines: [...got, ...before.lines] } }
        : { ...was, [key]: { from: before.from, to: first + got.length - 1, lines: [...before.lines, ...got] } };
    });
  }, [host, file, number, root, shown]);

  /* Everything fetched belongs to the file it was fetched from. Kept as a
     wholesale clear rather than a per-file map trim: it is one request to get
     it back, and a stale entry here is wrong code under a right line number. */
  useEffect(() => { setShown({}); setSlipped(null); }, [file?.path]);

  const add = useCallback((): void => {
    if (!writing || !writing.body.trim()) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const note: LineNote = {
      path: file?.path ?? "",
      line: writing.line,
      body: writing.body.trim(),
    };
    setQueued(takeDraft(key, (was) => [...was.filter((n) => !(n.path === note.path && n.line === note.line)), note]));
    setWriting(null);
  }, [writing, file, key]);

  /** Take one back. A queued remark is not on GitHub yet, so this is the whole
   *  of undoing it — no call, and nothing to tell anybody. */
  const drop = useCallback((note: LineNote): void => {
    setQueued(takeDraft(key, (was) => was.filter((n) => !(n.path === note.path && n.line === note.line))));
  }, [key]);

  /** One gap: what has already been fetched into it, and the offer to fetch
   *  more. Nothing at all when the file has no such gap, which is the ordinary
   *  case for two hunks that touch. */
  const gapBefore = (before: number): React.ReactNode => {
    const gap = gaps.find((g) => g.before === before);
    if (!gap || !file) return null;
    const key = `${file.path}#${before}`;
    const have = shown[key];
    const dir = dirOf(gap);
    const more = nextSlice(gap, dir, have ? (dir === "up" ? have.from : have.to) : null);
    const label = gapLabel(gap, more);
    const failed = slipped?.key === key ? slipped.text : null;
    // Up-growing gaps put the offer ABOVE what they have already shown, so the
    // control stays at the edge the next lines will appear at.
    const bar = label ? (
      <Expander label={label} busy={fetching === key} onPress={() => { void expand(gap); }} />
    ) : null;
    return (
      <>
        {dir === "up" ? bar : null}
        {have ? <Context from={have.from} lines={have.lines} /> : null}
        {dir === "down" ? bar : null}
        {failed ? (
          <Text style={{
            color: C.text4, fontSize: T.eyebrow, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs,
          }}>{failed}</Text>
        ) : null}
      </>
    );
  };

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

        {/* The conversations this file has that no line can hold. GitHub
            clears a thread's line when the code under it changes, and hanging
            one on whatever now carries that number would be a remark about
            code nobody was talking about — so they sit above the file, with
            the hunk they were written against, which is the only copy of
            those lines left anywhere. */}
        {onFile.adrift.length ? (
          <View style={{ padding: SPACE.lg, gap: SPACE.md }}>
            <Label text={onFile.adrift.length === 1
              ? "One conversation about lines that have changed"
              : `${onFile.adrift.length} conversations about lines that have changed`} />
            {onFile.adrift.map((thread) => (
              <ThreadCard key={thread.id} thread={thread} host={host} actions={actions} />
            ))}
          </View>
        ) : null}

        {file?.hunks.map((hunk, h) => (
          <View key={`${hunk.header}-${h}`}>
            {gapBefore(h)}
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

                  {yoursOn(line.newNo ?? null)}
                  {threadsOn(line.newNo ?? null)}

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

        {/* The tail of the file, below the last hunk. Rendered outside the map
            because it belongs to no hunk — `gapsIn` numbers it `hunks.length`
            for exactly this. */}
        {file && !file.binary ? gapBefore(file.hunks.length) : null}

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
        {queued.length > 0 ? (
          <Btn
            label={`Review · ${queued.length}`}
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

      {actions.confirming ? (
        <ApplyConfirm
          thread={actions.confirming.thread}
          text={actions.confirming.text}
          branch={detail?.headRefName}
          onCancel={actions.cancelApply}
          onApply={() => { void actions.apply(); }}
        />
      ) : null}

      <Sheet open={picking} onClose={() => setPicking(false)} title="Files">
        {files.map((f, i) => (
          <SheetRow
            key={`${f.path}-${i}`}
            label={fileLabel(f)}
            sub={[
              f.binary ? "binary" : `+${f.additions} −${f.deletions}`,
              // The number that decides which file to open next, on the row
              // that opens it.
              openByPath.get(f.path)
                ? `${openByPath.get(f.path)} open`
                : null,
            ].filter(Boolean).join(" · ")}
            on={i === at}
            onPress={() => { setAt(i); setWriting(null); setPicking(false); }}
          />
        ))}
      </Sheet>
    </KeyboardAvoidingView>
  );
}
