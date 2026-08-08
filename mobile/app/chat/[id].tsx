/*
 * One conversation, and the thing a phone is for: saying something back.
 *
 * The feed is the browser companion's `buildFeed` — messages and the work
 * between them, in order, with two separate budgets so that a turn which
 * touched forty files cannot evict everything the agent said. Its rules about
 * what counts as conversation (and what is transcript bookkeeping wearing a
 * message's clothes) are already tested; they are imported, not re-decided.
 *
 * ── why the reply does not stream ────────────────────────────────────────
 * `/chat/send` answers with NDJSON as the agent works, and React Native's fetch
 * cannot read a body incrementally — it is XHR underneath. So the phone posts
 * the turn, confirms it was accepted, and reads the transcript back. That is
 * not a workaround so much as the honest shape here: the session lives on the
 * server, so the transcript is the source of truth and a stream would only be
 * a faster copy of it.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Pressable, Text, TextInput, View,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { HeaderHeightContext } from "expo-router/build/react-navigation/elements";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SessionDetail } from "../../../shared/types.ts";
import { buildFeed, type FeedItem } from "../../src/model/transcript.ts";
import { ask, startTurn } from "../../src/lib/api.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { useKeyboardShown } from "../../src/state/use-keyboard.ts";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { Card, Label, Note, TAP } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T, ink } from "../../src/theme.ts";

/** While a turn is in flight the transcript is the only way to see it move, so
 *  it is re-read on a short clock — and only then. */
const WHILE_WORKING_MS = 3_000;

function Message({ item }: { item: Extract<FeedItem, { kind: "message" }> }): React.ReactNode {
  const mine = item.role === "user";
  return (
    <View style={{
      alignSelf: mine ? "flex-end" : "flex-start",
      maxWidth: "88%",
      backgroundColor: mine ? C.bg3 : C.bg2,
      borderWidth: 1,
      borderColor: mine ? C.border2 : C.border,
      borderRadius: RADIUS.lg,
      padding: SPACE.md,
    }}>
      <Text style={{ color: mine ? C.text : C.text2, fontSize: T.body, lineHeight: 20 }}>
        {item.text}
      </Text>
    </View>
  );
}

/** A run of tool calls, collapsed. Open it and it names them; closed it says
 *  how many and whether any failed, which is the part you scan for. */
function Tools({ item }: { item: Extract<FeedItem, { kind: "tools" }> }): React.ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen((v) => !v)} style={{ alignSelf: "stretch" }}>
      <View style={{
        borderLeftWidth: 2,
        borderLeftColor: item.errors ? C.error : C.border2,
        paddingLeft: SPACE.md,
        gap: SPACE.xs,
      }}>
        <Text style={{ color: item.errors ? C.error : C.text4, fontSize: T.eyebrow }}>
          {open ? "▾" : "▸"} {item.runs.length} {item.runs.length === 1 ? "step" : "steps"}
          {item.errors ? ` · ${item.errors} failed` : ""}
        </Text>
        {open
          ? item.runs.map((run, i) => (
              <Text
                key={`${run.ts}-${i}`}
                style={{ color: run.is_error ? C.error : C.text3, fontSize: T.eyebrow, fontFamily: MONO }}
                numberOfLines={2}
              >
                {run.tool}{run.target ? ` · ${run.target}` : ""}
              </Text>
            ))
          : null}
      </View>
    </Pressable>
  );
}

export default function ChatScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const insets = useSafeAreaInsets();
  /** The navigator's own measurement of its header, top inset included.
   *
   *  The context rather than `useHeaderHeight()`, which is the same number
   *  through a hook that THROWS when nothing above it has a header. This screen
   *  is walked by `bun scripts/qa.ts` on the web target as well as pushed on a
   *  phone, and a missing header there should cost an offset of zero, not the
   *  screen. */
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  /** Whether the gesture bar is currently under a keyboard — see the input's
   *  own padding below for what that changes. */
  const keyboard = useKeyboardShown();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [working, setWorking] = useState(false);
  const list = useRef<FlatList<FeedItem>>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!host || !id) return;
    const answer = await ask<SessionDetail>(host, `/session?id=${encodeURIComponent(id)}`);
    if (!answer.ok) { setError(answer.error); return; }
    setError(null);
    setDetail(answer.value);
  }, [host, id]);

  useEffect(() => { void load(); }, [load]);

  // Only while something is happening. A transcript that polls for ever is a
  // phone talking to the network with the screen off.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => { void load(); }, WHILE_WORKING_MS);
    return () => clearInterval(timer);
  }, [working, load]);

  // The turn has landed when the transcript's last word is the agent's.
  useEffect(() => {
    if (!working || !detail) return;
    const last = [...(detail.timeline ?? [])].find((e) => e.kind === "message");
    if (last && (last as { role?: string }).role === "assistant") setWorking(false);
  }, [detail, working]);

  const feed = useMemo(
    () => buildFeed(detail?.timeline as never),
    [detail],
  );

  const cwd = detail?.cwd_path || detail?.project_path || "";

  const send = useCallback(async (): Promise<void> => {
    if (!host || !detail || !draft.trim() || !cwd) return;
    setSending(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const answer = await startTurn(host, {
      cwd,
      message: draft.trim(),
      // The session's own model and its default mode: a phone is for replying
      // to work that is already set up, not for changing how it runs.
      model: detail.model_name ?? "",
      mode: "default",
      resumeId: detail.session_id,
    });
    setSending(false);
    if (!answer.ok) { setError(answer.error); return; }
    setDraft("");
    setError(null);
    setWorking(true);
    void load();
  }, [host, detail, draft, cwd, load]);

  const name = detail?.custom_title || detail?.ai_title
    || (detail?.first_prompt ?? "").slice(0, 60) || "Conversation";

  return (
    /*
     * `padding` on Android too, and the offset MEASURED rather than assumed.
     * The arithmetic behind both is written out in app/(tabs)/terminal.tsx.
     *
     * This screen shipped `behavior={undefined}` on Android, which does exactly
     * nothing and left the whole layout where it was. That was right only for
     * as long as the system resized the window under `adjustResize`. It does
     * not any more: Expo Go targets SDK 36 (`dumpsys package host.exp.exponent`
     * → targetSdk=36), and from Android 15 a window that opted into
     * edge-to-edge is not resized for the keyboard — the IME arrives as an
     * inset instead. Measured on two emulators running the same Expo Go and
     * the same bundle: on API 34 the input rose above the keyboard, on API 36
     * it was drawn behind it. That is the report, reproduced.
     *
     * The offset has to be where this view starts ON THE SCREEN, because RN
     * subtracts a keyboard top in screen coordinates from `frame.y +
     * frame.height`, and that frame is a layout relative to the PARENT — here
     * the stack's content view, which begins under the header. It was
     * `insets.top + 44`, a guess at a header; the navigator measures the real
     * one and publishes it on HeaderHeightContext (NativeStackView.native.js
     * sets it from the header's own onLayout). Ask, do not guess.
     */
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: C.bg }}
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Screen options={{ title: name }} />

      <FlatList
        ref={list}
        data={feed}
        keyExtractor={(item, i) => `${item.kind}-${item.ts}-${i}`}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.lg }}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          detail === null && !error ? null : (
            <Card>
              <Label text={error ? "Cannot read it" : "Nothing said yet"} />
              <Note tone={error ? "bad" : "quiet"}>
                {error ?? "This session has no messages on record."}
              </Note>
            </Card>
          )
        }
        renderItem={({ item }) =>
          item.kind === "message" ? <Message item={item} />
          : item.kind === "tools" ? <Tools item={item} />
          : (
            // A turn that was cut off. One thin centred line, because it is a
            // fact about the session and not something anybody said.
            <Text style={{ color: C.text4, fontSize: T.eyebrow, textAlign: "center" }}>{item.text}</Text>
          )}
      />

      {working ? (
        <View style={{
          flexDirection: "row", alignItems: "center", gap: SPACE.sm,
          paddingHorizontal: SPACE.lg, paddingVertical: SPACE.xs, backgroundColor: C.bg2,
        }}>
          <ActivityIndicator size="small" color={C.text3} />
          <Text style={{ color: C.text3, fontSize: T.eyebrow }}>Working…</Text>
        </View>
      ) : null}

      <View style={{
        flexDirection: "row", gap: SPACE.sm, alignItems: "flex-end",
        paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm,
        // The bottom inset is the gesture bar, and a keyboard covers the
        // gesture bar. Paying it anyway while the keyboard is up leaves the
        // input floating that far above the keys — the same strip, charged
        // twice, once by us and once by the padding the view above adds.
        paddingBottom: (keyboard ? 0 : insets.bottom) + SPACE.sm,
        borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
      }}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={cwd ? "Say something back" : "This session has no directory on record"}
          placeholderTextColor={C.text4}
          editable={!!cwd && !sending}
          multiline
          style={{
            flex: 1, minHeight: TAP, maxHeight: 140,
            borderRadius: RADIUS.md, backgroundColor: C.bg,
            borderWidth: 1, borderColor: C.border, color: C.text,
            paddingHorizontal: SPACE.md, paddingTop: SPACE.sm, paddingBottom: SPACE.sm,
            fontSize: T.body,
          }}
        />
        <Pressable
          onPress={() => { void send(); }}
          disabled={!draft.trim() || sending || !cwd}
          style={{
            width: TAP, height: TAP, borderRadius: RADIUS.md,
            alignItems: "center", justifyContent: "center",
            backgroundColor: draft.trim() && cwd ? C.primary : C.bg3,
            opacity: sending ? 0.5 : 1,
          }}
        >
          {sending
            ? <ActivityIndicator size="small" color={ink(C.primary)} />
            : <Text style={{ color: draft.trim() && cwd ? ink(C.primary) : C.text4, fontSize: T.title }}>↑</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
