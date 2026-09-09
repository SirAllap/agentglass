/*
 * One conversation on a line, drawn the same wherever it appears.
 *
 * The threads screen lists these; the diff screen puts one under the row of
 * code it is about. That is the whole reason this is a component and not part
 * of a screen — a reply box that looks and behaves differently depending on
 * which way you arrived at the same thread is two apps.
 *
 * Bodies go through the markdown renderer. A review comment is where a
 * suggestion block lives, and a ```suggestion fence printed verbatim is the
 * single worst thing this app used to show: five lines of markup wrapped at
 * eleven points, with the code the person is proposing hidden inside it.
 */
import { Linking, Pressable, Text, TextInput, View } from "react-native";
import type { PrThread } from "../../../shared/types.ts";
import { suggestionRange, suggestionsIn } from "../../../shared/suggestion.ts";
import { since } from "../lib/dates.ts";
import type { Host } from "../lib/host.ts";
import { Md } from "../md/Md.tsx";
import { hunkTail, replyAnchor, whereOf } from "../model/threads.ts";
import { Btn, Card, Note, TAP } from "../ui.tsx";
import { C, MONO, RADIUS, SPACE, T, tint } from "../theme.ts";
import type { ThreadActions } from "./useThreadActions.ts";

/** The diff hunk GitHub kept with the comment, trimmed to what fits.
 *  Kept because a reply written without seeing the code it is about is a reply
 *  about the wrong thing — and on an outdated thread this is the ONLY copy of
 *  those lines left anywhere in the app. */
export function Hunk({ text }: { text: string }): React.ReactNode {
  const { lines: shown, clipped } = hunkTail(text);
  return (
    <View style={{ backgroundColor: C.bg, borderRadius: RADIUS.sm, paddingVertical: SPACE.xs }}>
      {clipped ? (
        <Text style={{ color: C.text4, fontSize: 10, fontFamily: MONO, paddingHorizontal: SPACE.sm }}>⋯</Text>
      ) : null}
      {shown.map((line, i) => {
        const add = line.startsWith("+");
        const del = line.startsWith("-");
        return (
          <Text
            key={i}
            numberOfLines={1}
            style={{
              color: add ? C.success : del ? C.error : C.text3,
              backgroundColor: add ? tint(C.success, 0.12) : del ? tint(C.error, 0.12) : "transparent",
              fontSize: 10, fontFamily: MONO, lineHeight: 16, paddingHorizontal: SPACE.sm,
            }}
          >{line}</Text>
        );
      })}
    </View>
  );
}

/**
 * @param where  Draw the `path:line` header. On the threads screen that is how
 *               you know which file you are reading about; on the diff it is
 *               the line you are already looking at, so it is off there.
 * @param hunk   Draw the hunk GitHub kept. Same argument: on the diff the code
 *               is directly above, and printing it again pushes the words off
 *               the screen.
 */
export function ThreadCard({ thread, host, actions, where = true, hunk = true, now = Date.now() }: {
  thread: PrThread;
  host: Host | null;
  actions: ThreadActions;
  where?: boolean;
  hunk?: boolean;
  now?: number;
}): React.ReactNode {
  const range = suggestionRange(thread);
  /* The FIRST suggestion in the thread, which is the one the range belongs to.
     A later reply containing its own block is a different proposal about the
     same lines, and applying it under the first one's range would be applying
     something nobody chose. */
  const suggestion = thread.comments.flatMap((c) => suggestionsIn(c.body)).at(0);
  const canApply = actions.mayWrite && !!suggestion && !!range && !thread.isResolved;
  const canReply = actions.mayWrite && replyAnchor(thread) !== null;
  const note = actions.said?.id === thread.id ? actions.said : null;
  const working = actions.busy === thread.id;
  const writing = actions.writing?.id === thread.id ? actions.writing : null;

  return (
    <Card style={{ gap: SPACE.sm, opacity: thread.isResolved ? 0.6 : 1 }}>
      {where || thread.isResolved || thread.isOutdated ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
          {where ? (
            <Text
              numberOfLines={1}
              ellipsizeMode="head"
              style={{ color: C.text2, fontSize: T.small, fontFamily: MONO, flex: 1 }}
            >{whereOf(thread)}</Text>
          ) : <View style={{ flex: 1 }} />}
          {thread.isResolved ? (
            <Text style={{ color: C.success, fontSize: T.eyebrow }}>resolved</Text>
          ) : thread.isOutdated ? (
            <Text style={{ color: C.text4, fontSize: T.eyebrow }}>outdated</Text>
          ) : null}
        </View>
      ) : null}

      {hunk && thread.diffHunk ? <Hunk text={thread.diffHunk} /> : null}

      {thread.comments.map((comment) => (
        <View key={comment.id} style={{ gap: 2, paddingTop: SPACE.xs }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
            <Text style={{ color: C.text, fontSize: T.small, fontWeight: "600" }}>
              {comment.author}{comment.isBot ? " · bot" : ""}
            </Text>
            <Text style={{ color: C.text4, fontSize: T.eyebrow }}>
              {since(comment.createdAt, now)}
            </Text>
          </View>
          <Md text={comment.body} host={host} />
        </View>
      ))}

      {writing ? (
        <View style={{ gap: SPACE.sm, paddingTop: SPACE.xs }}>
          <TextInput
            value={writing.body}
            onChangeText={actions.type}
            placeholder="Reply"
            placeholderTextColor={C.text4}
            multiline
            autoFocus
            style={{
              minHeight: 64, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.sm,
              backgroundColor: C.bg, color: C.text, padding: SPACE.sm, fontSize: T.body,
            }}
          />
          <View style={{ flexDirection: "row", gap: SPACE.sm }}>
            <Btn
              label="Send reply"
              tone="primary"
              style={{ flex: 1 }}
              busy={working}
              disabled={!writing.body.trim() || working}
              onPress={() => { void actions.reply(thread); }}
            />
            <Btn label="Cancel" onPress={actions.cancel} />
          </View>
          {/* Said where the difference bites: this one goes now, and the
              remarks written on the diff do not. */}
          <Note>A reply is posted on its own, straight away.</Note>
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: SPACE.sm, paddingTop: SPACE.xs }}>
          <Btn
            label="Reply"
            style={{ flex: 1 }}
            disabled={!canReply || working}
            onPress={() => actions.begin(thread)}
          />
          <Btn
            label={thread.isResolved ? "Reopen" : "Resolve"}
            tone={thread.isResolved ? "plain" : "good"}
            style={{ flex: 1 }}
            busy={working}
            disabled={!actions.mayWrite || working}
            onPress={() => actions.setResolved(thread)}
          />
        </View>
      )}

      {canApply ? (
        <Btn
          label={`Apply suggestion · ${thread.path.split("/").pop()}:${
            range!.startLine === range!.line ? range!.line : `${range!.startLine}-${range!.line}`
          }`}
          disabled={working}
          onPress={() => actions.askApply(thread, suggestion!.text)}
        />
      ) : null}

      {suggestion && !range ? (
        <Note>
          This thread carries a suggestion, and the lines it was written about are gone.
          Applying it would change code nobody was talking about.
        </Note>
      ) : null}

      {note ? <Note tone={note.bad ? "bad" : "quiet"}>{note.text}</Note> : null}

      {thread.url ? (
        <Pressable
          onPress={() => { void Linking.openURL(thread.url!); }}
          accessibilityRole="button"
          style={{ minHeight: TAP, justifyContent: "center" }}
        >
          <Text style={{ color: C.primary, fontSize: T.small }}>Open the thread on GitHub</Text>
        </Pressable>
      ) : null}
    </Card>
  );
}
